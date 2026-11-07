import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { SERVICE_STATES, readServiceStatus, writeServiceStatus, type ServiceStatus } from "./service-status"
import { shortTempDir } from "./sync.testing"
import { pathsIn } from "./wacli.testing"

let dir: string
let paths: ReturnType<typeof pathsIn>

beforeEach(async () => {
  dir = await shortTempDir()
  paths = pathsIn(dir)
  await mkdir(paths.dir, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const STATUS: ServiceStatus = {
  state: "running",
  pid: 4242,
  since: "2026-11-07T05:03:12.345Z",
  last_event: { name: "connected", at: "2026-11-07T05:03:13.000Z" },
}

describe("writeServiceStatus and readServiceStatus", () => {
  test("round-trip a status", () => {
    writeServiceStatus(paths, STATUS)
    expect(readServiceStatus(paths)).toEqual(STATUS)
  })

  test("round-trip every state, with a null pid and a reason", () => {
    for (const state of SERVICE_STATES) {
      const status: ServiceStatus = { state, pid: null, since: STATUS.since, reason: "because" }
      writeServiceStatus(paths, status)
      expect(readServiceStatus(paths)).toEqual(status)
    }
  })

  test("write the file readable by the owner only, and leave no temporary file", () => {
    writeServiceStatus(paths, STATUS)
    writeServiceStatus(paths, { ...STATUS, state: "paused" })
    expect(statSync(paths.serviceStatus).mode & 0o777).toBe(0o600)
    expect(readdirSync(paths.dir)).toEqual(["service.json"])
  })

  test("replace the previous status", () => {
    writeServiceStatus(paths, STATUS)
    writeServiceStatus(paths, { state: "stopped", pid: null, since: STATUS.since })
    expect(readServiceStatus(paths)).toEqual({ state: "stopped", pid: null, since: STATUS.since })
  })

  test("mask numbers and JIDs in the reason", () => {
    writeServiceStatus(paths, { ...STATUS, reason: "failed for +15551234567 and 15551234567@s.whatsapp.net" })
    const text = readFileSync(paths.serviceStatus, "utf8")
    expect(text).not.toContain("5551234567")
    expect(readServiceStatus(paths)?.reason).toBe("failed for <number> and <number>@s.whatsapp.net")
  })

  test("fail, leaving nothing behind, when the directory is missing", () => {
    const missing = { ...paths, serviceStatus: join(dir, "missing", "service.json") }
    expect(() => writeServiceStatus(missing, STATUS)).toThrow()
    expect(existsSync(join(dir, "missing"))).toBe(false)
  })
})

describe("readServiceStatus", () => {
  const write = (content: string) => writeFileSync(paths.serviceStatus, content)

  test("is null when there is no file", () => {
    expect(readServiceStatus(paths)).toBeNull()
  })

  test("is null for text that is not JSON", () => {
    write("{ nope")
    expect(readServiceStatus(paths)).toBeNull()
  })

  test("is null for JSON that is not a status", () => {
    for (const content of [
      "[]",
      "null",
      "{}",
      JSON.stringify({ state: "dancing", pid: 1, since: "x" }),
      JSON.stringify({ state: "running", pid: "1", since: "x" }),
      JSON.stringify({ state: "running", pid: 1.5, since: "x" }),
      JSON.stringify({ state: "running", pid: 1 }),
      JSON.stringify({ state: "running", since: "x" }),
    ]) {
      write(content)
      expect(readServiceStatus(paths)).toBeNull()
    }
  })

  test("ignores a last event that is not one, and fields it does not know", () => {
    write(JSON.stringify({ state: "failed", pid: null, since: "x", last_event: { name: 3 }, extra: true }))
    expect(readServiceStatus(paths)).toEqual({ state: "failed", pid: null, since: "x" })
  })
})
