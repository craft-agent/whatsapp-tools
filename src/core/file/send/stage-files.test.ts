import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { ELF_BYTES } from "../../archive/archive.testing"
import { createSandbox, fakeKey, toolFailure, type Sandbox } from "../../outgoing/outgoing.testing"
import { stageOutgoing, type StageOptions } from "./stage-files"

let box: Sandbox
let work: string
let outbox: string

beforeEach(() => {
  box = createSandbox()
  work = box.mkdir("work")
  outbox = join(box.mkdir("state/label"), "outbox")
})
afterEach(() => box.remove())

const run = (
  files: { path: string; sha256?: string }[],
  options: Partial<StageOptions> = {},
  sendDirs: string[] = [],
) =>
  stageOutgoing(
    files,
    { cwd: work, sendDirs, stateDir: join(box.root, "state"), ownDir: undefined },
    { outbox, ...options },
  )

const outboxEntries = () => (existsSync(outbox) ? readdirSync(outbox) : [])

describe("stageOutgoing", () => {
  test("copies each file into its own folder of a new call folder and reports it", async () => {
    box.write("work/a.txt", "hello\n")
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    box.write("work/sub/b.png", png)
    const staged = await run([{ path: "a.txt" }, { path: "sub/b.png" }])
    expect(staged.files.map((file) => file.name)).toEqual(["a.txt", "b.png"])
    const [first, second] = staged.files
    expect(first).toMatchObject({
      path: join(staged.folder, "0", "a.txt"),
      size: 6,
      sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
      realPath: join(work, "a.txt"),
      check: { kind: "file", size: 6 },
    })
    expect(first!.check.head.toString()).toBe("hello\n")
    expect(readFileSync(first!.path, "utf8")).toBe("hello\n")
    expect(second!.path).toBe(join(staged.folder, "1", "b.png"))
    expect(Buffer.from(second!.check.head)).toEqual(Buffer.from(png))
    expect(statSync(outbox).mode & 0o777).toBe(0o700)
    await staged.remove()
    expect(outboxEntries()).toEqual([])
  })

  test("takes files from a send directory", async () => {
    const other = box.mkdir("other")
    box.write("other/a.txt")
    const staged = await run([{ path: join(other, "a.txt") }], {}, [other])
    expect(staged.files[0]!.realPath).toBe(join(other, "a.txt"))
    await staged.remove()
  })

  test("is forbidden for a file outside the allowed directories, and makes no folder", async () => {
    const outside = box.write("outside/a.txt")
    const error = await toolFailure(() => run([{ path: outside }]))
    expect(error.code).toBe("forbidden")
    expect(outboxEntries()).toEqual([])
  })

  test("removes the call folder when a later file is refused, naming the file as given", async () => {
    box.write("work/a.txt")
    box.write("work/prog", ELF_BYTES)
    const error = await toolFailure(() => run([{ path: "a.txt" }, { path: "prog" }]))
    expect(error.code).toBe("forbidden")
    expect(error.message).toStartWith('"prog" cannot be sent: ')
    expect(outboxEntries()).toEqual([])
  })

  test("refuses a file that holds a private key", async () => {
    box.write("work/notes.txt", fakeKey())
    const error = await toolFailure(() => run([{ path: "notes.txt" }]))
    expect(error.code).toBe("forbidden")
    expect(outboxEntries()).toEqual([])
  })

  test("is stale for a digest that differs, after an earlier file was copied", async () => {
    box.write("work/a.txt")
    box.write("work/b.txt")
    const error = await toolFailure(() => run([{ path: "a.txt" }, { path: "b.txt", sha256: "0".repeat(64) }]))
    expect(error.code).toBe("stale")
    expect(outboxEntries()).toEqual([])
  })

  test("is invalid for files over the byte limit", async () => {
    box.write("work/a.txt", "x".repeat(60))
    box.write("work/b.txt", "y".repeat(60))
    const error = await toolFailure(() => run([{ path: "a.txt" }, { path: "b.txt" }], { maxTotalBytes: 100 }))
    expect(error.code).toBe("invalid_argument")
    expect(outboxEntries()).toEqual([])
  })

  test("stops for an aborted signal and leaves no folder", async () => {
    box.write("work/a.txt")
    const controller = new AbortController()
    controller.abort()
    await expect(run([{ path: "a.txt" }], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(outboxEntries()).toEqual([])
  })

  test("sweeps folders older than 24 hours first, even when the call then fails", async () => {
    const old = join(outbox, "a".repeat(32))
    mkdirSync(old, { recursive: true, mode: 0o700 })
    const when = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(old, when, when)
    await toolFailure(() => run([{ path: "missing.txt" }]))
    expect(existsSync(old)).toBe(false)
  })
})
