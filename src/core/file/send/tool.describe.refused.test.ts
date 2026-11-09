import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { truncateSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { ALICE, wacliChat } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { ToolError } from "../../errors"
import { MAX_TOTAL_BYTES } from "../../outgoing/limits"
import { createSandbox, type Sandbox } from "../../outgoing/outgoing.testing"
import type { ToolContext } from "../../tool"
import { input } from "./schema"
import { JPEG, createFileSendTest, type FileSendTest } from "./tool.testing"
import { createFileSend } from "./tool"

let t: FileSendTest
let elsewhere: Sandbox

/**
 * A spy on `open` of `node:fs/promises`, which still opens: every read of a file's bytes starts with it, so a refused
 * file whose path never reached it was never read. (A file mode of 000 cannot show this: resolving such a file
 * already fails on macOS, whether or not anything would go on to read it.)
 */
let openSpy: ReturnType<typeof spyOn<typeof fsPromises, "open">>

/** The paths `open` was called with since the test began. */
const opened = () => openSpy.mock.calls.map(([path]) => String(path))

beforeEach(async () => {
  t = await createFileSendTest()
  t.setUp({ mirror: { chats: [wacliChat({ jid: ALICE, name: "Alice" })], messages: [] } })
  elsewhere = createSandbox()
  openSpy = spyOn(fsPromises, "open")
})

afterEach(async () => {
  openSpy.mockRestore()
  elsewhere.remove()
  await t.close()
})

const tool = createFileSend()
const context = (): ToolContext => ({ cwd: t.box.root, stateDir: t.fixture.stateDir })
const describeCall = (args: Record<string, unknown>) => callDescription(tool, { chat: ALICE, ...args }, context())

/** What `describe` throws, called without the wrapper that turns a failure into no description. */
async function refusal(files: { path: string; sha256?: string }[]): Promise<ToolError> {
  try {
    await tool.describe!(input.parse({ chat: ALICE, files }), context())
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("expected describe to fail")
}

describe("a file send the tool would refuse", () => {
  test("gives no description for a file named like a secret or a key, or outside the directories", async () => {
    t.box.write(".env", "KEY=value\n")
    t.box.write("id_rsa", "made up\n")
    const outside = elsewhere.write("photo.jpg", JPEG)
    for (const path of [".env", "id_rsa", outside]) {
      expect(await describeCall({ files: [{ path }] })).toBeUndefined()
    }
  })

  test("refuses by name, by folder and by place without opening the file", async () => {
    const byName = t.box.write(".env", "KEY=value\n")
    const byPlace = elsewhere.write("photo.jpg", JPEG)
    const byFolder = t.box.write(".ssh/notes.txt", "hello\n")
    expect((await refusal([{ path: ".env" }])).message).toContain("named like a key or a secret")
    expect((await refusal([{ path: byPlace }])).message).toContain("outside the directories")
    expect((await refusal([{ path: byFolder }])).message).toContain("key or settings folder")
    for (const path of [byName, byPlace, byFolder]) expect(opened()).not.toContain(path)
  })

  test("resolves every file before it reads any: a refused later file means the earlier one is never opened", async () => {
    const first = t.box.write("first.txt", "allowed by the rules\n")
    t.box.write(".env", "KEY=value\n")
    const error = await refusal([{ path: "first.txt" }, { path: ".env" }])
    expect(error.message).toContain("named like a key or a secret")
    expect(opened()).not.toContain(first)
  })

  test("does open the files that pass, by their real paths", async () => {
    const real = t.box.write("notes.txt", "hello\n")
    await describeCall({ files: [{ path: "notes.txt" }] })
    expect(opened()).toContain(real)
  })

  test("gives no description for a file that does not exist, an empty file or a file named twice", async () => {
    t.box.write("empty.txt", "")
    t.box.write("notes.txt", "hello\n")
    expect(await describeCall({ files: [{ path: "missing.txt" }] })).toBeUndefined()
    expect(await describeCall({ files: [{ path: "empty.txt" }] })).toBeUndefined()
    expect(await describeCall({ files: [{ path: "notes.txt" }, { path: "notes.txt" }] })).toBeUndefined()
  })

  test("gives no description for a SHA-256 that differs, and one for the SHA-256 it matches in either case", async () => {
    t.box.write("holiday.jpg", JPEG)
    const real = (await describeCall({ files: [{ path: "holiday.jpg" }] }))!.pins!["sha256:0"]!
    const other = "0".repeat(64)
    expect(await describeCall({ files: [{ path: "holiday.jpg", sha256: other }] })).toBeUndefined()
    expect(await refusal([{ path: "holiday.jpg", sha256: other }])).toMatchObject({ code: "stale" })
    expect(await describeCall({ files: [{ path: "holiday.jpg", sha256: real.toUpperCase() }] })).toBeDefined()
  })

  test("gives no description for files over the size a send takes, without reading past it", async () => {
    const path = t.box.write("big.bin", "x")
    truncateSync(path, MAX_TOTAL_BYTES + 1)
    expect(await refusal([{ path: "big.bin" }])).toMatchObject({ code: "invalid_argument" })
  })

  test("stops with the signal's error when the call is cancelled", async () => {
    t.box.write("holiday.jpg", JPEG)
    const controller = new AbortController()
    controller.abort()
    await expect(
      callDescription(
        tool,
        { chat: ALICE, files: [{ path: "holiday.jpg" }] },
        { ...context(), signal: controller.signal },
      ),
    ).rejects.toThrow()
  })
})
