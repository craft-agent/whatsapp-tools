import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureLabelDir, type LabelPaths } from "./labels"
import { missingServiceFiles, readServiceRecord, removeServiceRecord, writeServiceRecord } from "./service-record"
import { shortTempDir } from "./sync.testing"

let root: string
let paths: LabelPaths

beforeEach(async () => {
  root = await shortTempDir()
  paths = await ensureLabelDir(join(root, "state"), "default")
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const record = { program: "/made/up/program", script: "/made/up/script.js" }

describe("write and read", () => {
  test("round-trips", async () => {
    await writeServiceRecord(paths, record)
    expect(readServiceRecord(paths)).toEqual(record)
  })

  test("is its own file, apart from the state the service records about itself", async () => {
    await writeServiceRecord(paths, record)
    expect(paths.serviceRecord).not.toBe(paths.serviceStatus)
    expect(existsSync(paths.serviceStatus)).toBe(false)
  })

  test("file mode is 0600 and no staging file remains", async () => {
    await writeServiceRecord(paths, record)
    expect(statSync(paths.serviceRecord).mode & 0o777).toBe(0o600)
    expect(readdirSync(paths.dir)).not.toContain(".service-program.json.tmp")
  })

  test("a second write replaces the first", async () => {
    await writeServiceRecord(paths, record)
    const next = { program: "/made/up/other", script: "/made/up/other.js" }
    await writeServiceRecord(paths, next)
    expect(readServiceRecord(paths)).toEqual(next)
  })

  test("a leftover staging file is replaced", async () => {
    writeFileSync(join(paths.dir, ".service-program.json.tmp"), "stale")
    await writeServiceRecord(paths, record)
    expect(readServiceRecord(paths)).toEqual(record)
  })
})

describe("readServiceRecord returns null", () => {
  test("for a missing file", () => {
    expect(readServiceRecord(paths)).toBeNull()
  })

  test("for invalid JSON", () => {
    writeFileSync(paths.serviceRecord, "{not json")
    expect(readServiceRecord(paths)).toBeNull()
  })

  test.each([
    ["not an object", "[]"],
    ["null", "null"],
    ["missing program", JSON.stringify({ script: "/made/up/script.js" })],
    ["missing script", JSON.stringify({ program: "/made/up/program" })],
    ["empty program", JSON.stringify({ program: "", script: "/made/up/script.js" })],
    ["empty script", JSON.stringify({ program: "/made/up/program", script: "" })],
    ["non-string program", JSON.stringify({ program: 1, script: "/made/up/script.js" })],
    ["non-string script", JSON.stringify({ program: "/made/up/program", script: null })],
  ])("for %s", (_name, body) => {
    writeFileSync(paths.serviceRecord, body)
    expect(readServiceRecord(paths)).toBeNull()
  })

  test("ignores extra keys", () => {
    writeFileSync(paths.serviceRecord, JSON.stringify({ ...record, extra: "x" }))
    expect(readServiceRecord(paths)).toEqual(record)
  })
})

describe("removeServiceRecord", () => {
  test("deletes the file", async () => {
    await writeServiceRecord(paths, record)
    await removeServiceRecord(paths)
    expect(existsSync(paths.serviceRecord)).toBe(false)
  })

  test("is a no-op when missing", async () => {
    await removeServiceRecord(paths)
    expect(existsSync(paths.serviceRecord)).toBe(false)
  })
})

describe("missingServiceFiles", () => {
  const program = () => join(root, "program")
  const script = () => join(root, "script.js")

  test("reports which paths are gone", () => {
    const rec = { program: program(), script: script() }
    expect(missingServiceFiles(rec)).toEqual(["program", "script"])
    writeFileSync(program(), "")
    expect(missingServiceFiles(rec)).toEqual(["script"])
    writeFileSync(script(), "")
    expect(missingServiceFiles(rec)).toEqual([])
    rmSync(program())
    expect(missingServiceFiles(rec)).toEqual(["program"])
  })

  test("a dangling symlink counts as missing", () => {
    symlinkSync(join(root, "gone"), program())
    writeFileSync(script(), "")
    expect(missingServiceFiles({ program: program(), script: script() })).toEqual(["program"])
  })
})
