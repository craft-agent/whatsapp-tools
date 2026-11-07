import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { ELF_BYTES } from "../archive/archive.testing"
import { buildZip } from "../archive/zip.testing"
import { QUARANTINE_ATTRIBUTE, XATTR } from "./quarantine"
import { abortAfter, createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
  t.respond(download("one"))
})
afterEach(() => t.close())

const SECONDS_HEX = Math.floor(1_700_000_123_000 / 1000).toString(16)
const VALUE = `0081;${SECONDS_HEX};whatsapp-tools;11111111-2222-4333-8444-555555555555`
const darwin = { platform: "darwin" as const }

describe("the quarantine mark on macOS", () => {
  test("the saved file is marked through the runner with the attribute, a value and its path", async () => {
    await t.save(saveArgs(), { host: darwin })
    expect(t.runs).toEqual([[XATTR, "-w", QUARANTINE_ATTRIBUTE, VALUE, join(t.folder, "notes.txt")]])
    expect(XATTR).toBe("/usr/bin/xattr")
    expect(QUARANTINE_ATTRIBUTE).toBe("com.apple.quarantine")
  })

  test("the value has the flags, the time in hexadecimal, the program's name and a UUID in capitals", async () => {
    await t.save(saveArgs(), { host: { ...darwin, uuid: () => "AB12CD34-0000-4000-8000-00000000000F" } })
    const value = t.runs[0]![3]!
    expect(value).toBe(`0081;${SECONDS_HEX};whatsapp-tools;AB12CD34-0000-4000-8000-00000000000F`)
    expect(value.split(";").at(-1)).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/)
  })

  test("the agent field is empty when the entry point named no program, and holds no ;", async () => {
    await t.save(saveArgs(), { host: darwin, ctx: { programName: undefined } })
    expect(t.runs[0]![3]).toBe(`0081;${SECONDS_HEX};;11111111-2222-4333-8444-555555555555`)
    t.runs.length = 0
    await t.save(saveArgs(), { host: darwin, ctx: { programName: "odd;name" } })
    expect(t.runs[0]![3]).toContain(";odd_name;")
  })

  test("a file that was already saved is marked again, which changes nothing", async () => {
    await t.save(saveArgs(), { host: darwin })
    t.runs.length = 0
    const again = await t.save(saveArgs(), { host: darwin })
    expect(again.file!.already_saved).toBe(true)
    expect(t.runs).toHaveLength(1)
  })

  test("a refused file is not marked, since it is not saved", async () => {
    t.message({ name: "tool.exe", type: "" })
    await t.save(saveArgs(), { host: darwin })
    t.message({ name: "cat.png", kind: "image", type: "image/png" })
    t.respond(download(ELF_BYTES))
    const result = await t.save(saveArgs(), { host: darwin })
    expect(result.refused).toBeDefined()
    expect(t.runs).toEqual([])
  })

  test("an unpacked tree is marked with one recursive call", async () => {
    t.message({ name: "pack.zip", type: "" })
    t.respond(download(buildZip([{ name: "d/f.txt", data: "x" }])))
    const result = await t.save(saveArgs({ unpack: true }), { host: darwin })
    expect(t.runs).toEqual([
      [XATTR, "-w", QUARANTINE_ATTRIBUTE, VALUE, join(t.folder, "pack.zip")],
      [XATTR, "-w", "-r", QUARANTINE_ATTRIBUTE, VALUE, result.file!.unpacked!],
    ])
  })

  test("an unpacked tree that was already there is not marked again", async () => {
    t.message({ name: "pack.zip", type: "" })
    t.respond(download(buildZip([{ name: "f.txt", data: "x" }])))
    await t.save(saveArgs({ unpack: true }), { host: darwin })
    t.runs.length = 0
    await t.save(saveArgs({ unpack: true }), { host: darwin })
    expect(t.runs.filter((run) => run.includes("-r"))).toEqual([])
  })
})

describe("elsewhere", () => {
  test.each(["linux", "win32", "freebsd"] as const)("nothing is run on %s", async (platform) => {
    const result = await t.save(saveArgs(), { host: { platform } })
    expect(t.runs).toEqual([])
    expect(result.errors).toBeUndefined()
  })
})

describe("a mark that does not take", () => {
  test("is listed under errors.quarantine, and the file stays saved", async () => {
    const run = async () => ({ code: 1, stdout: "", stderr: "xattr: No such file" })
    const result = await t.save(saveArgs(), { host: { ...darwin, run } })
    expect(result.file).toMatchObject({ name: "notes.txt" })
    expect(readdirSync(t.folder)).toEqual(["notes.txt"])
    expect(result.errors).toEqual({
      quarantine: "upstream_error: Not marked as downloaded: xattr failed: xattr: No such file",
    })
  })

  test("every path is tried even when the first fails", async () => {
    t.message({ name: "pack.zip", type: "" })
    t.respond(download(buildZip([{ name: "f.txt", data: "x" }])))
    let calls = 0
    const run = async () => ({ code: calls++ === 0 ? 1 : 0, stdout: "", stderr: "denied" })
    const result = await t.save(saveArgs({ unpack: true }), { host: { ...darwin, run } })
    expect(calls).toBe(2)
    expect(result.errors!.quarantine).toContain("xattr failed: denied")
    expect(result.errors!.quarantine).not.toContain("paths")
  })

  test("a program that cannot be started is listed too", async () => {
    const run = async (): Promise<never> => {
      throw Object.assign(new Error("spawn /usr/bin/xattr ENOENT"), { code: "ENOENT" })
    }
    const result = await t.save(saveArgs(), { host: { ...darwin, run } })
    expect(result.errors!.quarantine).toContain("xattr could not be run")
    expect(result.file).toBeDefined()
  })

  test("marking is not given the call's signal: it is quick and is not cancelled midway", async () => {
    const signals: unknown[] = []
    const run = async (_argv: string[], signal?: AbortSignal) => {
      signals.push(signal)
      return { code: 0, stdout: "", stderr: "" }
    }
    await t.save(saveArgs(), { host: { ...darwin, run }, ctx: { signal: abortAfter(1000) } })
    expect(signals).toEqual([undefined])
  })
})
