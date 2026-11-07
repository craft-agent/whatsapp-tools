import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildZip } from "../archive/zip.testing"
import { eventually } from "../whatsapp/sync.testing"
import { CANCELLED_MESSAGE } from "./constants"
import { QUARANTINE_ATTRIBUTE, XATTR } from "./quarantine"
import { MESSAGE_ID, abortAfter, createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
  t.respond(download("content"))
})
afterEach(() => t.close())

const darwin = { platform: "darwin" as const }

/** Whether a process with this id is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A host whose unpacking is cancelled the moment it starts, as a cancellation during it would. */
function cancelledUnpack() {
  const controller = new AbortController()
  const unpack = async (): Promise<never> => {
    controller.abort()
    throw controller.signal.reason
  }
  return { signal: controller.signal, unpack }
}

describe("a cancellation once the file is saved", () => {
  beforeEach(() => {
    t.message({ name: "pack.zip", type: "" })
    t.respond(download(buildZip([{ name: "d/f.txt", data: "x" }])))
  })

  test("ends the work but not the call: what was saved is listed, with errors.cancelled", async () => {
    const { signal, unpack } = cancelledUnpack()
    const result = await t.save(saveArgs({ unpack: true }), { host: { unpack }, ctx: { signal } })

    expect(result.file).toMatchObject({ name: "pack.zip" })
    expect(result.file!.unpacked).toBeUndefined()
    expect(result.errors).toEqual({ cancelled: CANCELLED_MESSAGE })
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("still marks what was placed, without the call's signal", async () => {
    const { signal, unpack } = cancelledUnpack()
    const result = await t.save(saveArgs({ unpack: true }), { host: { ...darwin, unpack }, ctx: { signal } })
    expect(t.runs).toEqual([
      [XATTR, "-w", QUARANTINE_ATTRIBUTE, expect.stringMatching(/^0081;/), join(t.folder, "pack.zip")],
    ])
    expect(result.errors).toEqual({ cancelled: CANCELLED_MESSAGE })
  })

  test("lists the errors of other steps beside it", async () => {
    const { signal, unpack } = cancelledUnpack()
    const run = async () => ({ code: 1, stdout: "", stderr: "nope" })
    const result = await t.save(saveArgs({ unpack: true }), { host: { ...darwin, run, unpack }, ctx: { signal } })
    expect(Object.keys(result.errors!).sort()).toEqual(["cancelled", "quarantine"])
  })

  test("a file that was already saved counts as saved", async () => {
    await t.save(saveArgs())
    const { signal, unpack } = cancelledUnpack()
    const result = await t.save(saveArgs({ unpack: true }), { host: { unpack }, ctx: { signal } })
    expect(result.file).toMatchObject({ name: "pack.zip", already_saved: true })
    expect(result.errors).toEqual({ cancelled: CANCELLED_MESSAGE })
  })
})

describe("a cancellation before the file is saved", () => {
  test("throws for a signal that is aborted already, and downloads nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(t.save(saveArgs(), { ctx: { signal: controller.signal } })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(await t.downloadCalls()).toEqual([])
    expect(existsSync(t.folder)).toBe(false)
  })

  test("throws when it comes before the download, which is then not started", async () => {
    await expect(t.save(saveArgs(), { ctx: { signal: abortAfter(0) } })).rejects.toMatchObject({ name: "AbortError" })
    expect(await t.downloadCalls()).toEqual([])
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("throws when it comes while the file is being copied, and removes the private copy and the download", async () => {
    await expect(t.save(saveArgs(), { ctx: { signal: abortAfter(1) } })).rejects.toMatchObject({ name: "AbortError" })
    expect(await t.downloadCalls()).toHaveLength(1)
    expect(readdirSync(t.folder)).toEqual([])
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("throws when it comes during the download, stops wacli and removes the folder it wrote in", async () => {
    t.respond(download("partial", { hang: true }))
    const controller = new AbortController()
    const pending = t.save(saveArgs(), { ctx: { signal: controller.signal } })
    const settled = pending.catch((error: unknown) => error)
    await eventually(async () => (await t.downloadCalls()).length === 1)
    controller.abort()

    expect(await settled).toMatchObject({ name: "AbortError" })
    expect(t.siblings()).toEqual([MESSAGE_ID])
    expect(readdirSync(t.folder)).toEqual([])
    const [call] = await t.downloadCalls()
    await eventually(() => !alive(call!.pid))
  })
})
