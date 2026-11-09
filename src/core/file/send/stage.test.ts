import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { createSandbox, toolFailure, type Sandbox } from "../../outgoing/outgoing.testing"
import { resolveOutgoing } from "../../outgoing/resolve"
import { stageFile } from "./stage"
import { canMakeFifo, makeFifo } from "./send.testing"

let box: Sandbox
let work: string
let folder: string

beforeEach(() => {
  box = createSandbox()
  work = box.mkdir("work")
  folder = box.mkdir("outbox/call")
})
afterEach(() => box.remove())

const resolveFile = (path: string) =>
  resolveOutgoing(path, { cwd: work, roots: [work], forbidden: [], home: box.mkdir("home") })

const stage = async (path: string, expected?: string, limit = 1000) =>
  stageFile(await resolveFile(path), JSON.stringify(path), join(folder, "0"), { used: 0, limit }, expected)

describe("stageFile", () => {
  test("copies the file privately under its name and reports its size and SHA-256", async () => {
    box.write("work/a.txt", "hello\n")
    const staged = await stage("a.txt")
    expect(staged).toMatchObject({ name: "a.txt", size: 6, path: join(folder, "0", "a.txt") })
    expect(staged.sha256).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03")
    expect(readFileSync(staged.path, "utf8")).toBe("hello\n")
    expect(statSync(staged.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(folder, "0")).mode & 0o777).toBe(0o700)
  })

  test("is stale when another file took the path between resolving and opening", async () => {
    const path = box.write("work/a.txt", "approved\n")
    const resolved = await resolveFile("a.txt")
    renameSync(path, join(work, "aside.txt"))
    writeFileSync(path, "swapped in\n")
    const error = await toolFailure(() =>
      stageFile(resolved, '"a.txt"', join(folder, "0"), { used: 0, limit: 1000 }, undefined),
    )
    expect(error.code).toBe("stale")
    expect(error.message).toBe('"a.txt" changed between being checked and being opened; try again.')
  })

  test("is stale when a link took the path, and follows it nowhere", async () => {
    const path = box.write("work/a.txt", "approved\n")
    const other = box.write("work/other.txt", "other\n")
    const resolved = await resolveFile("a.txt")
    rmSync(path)
    symlinkSync(other, path)
    expect(
      (await toolFailure(() => stageFile(resolved, '"a.txt"', folder, { used: 0, limit: 1000 }, undefined))).code,
    ).toBe("stale")
  })

  test("is stale when the file is gone", async () => {
    const path = box.write("work/a.txt")
    const resolved = await resolveFile("a.txt")
    rmSync(path)
    expect(
      (await toolFailure(() => stageFile(resolved, '"a.txt"', folder, { used: 0, limit: 1000 }, undefined))).code,
    ).toBe("stale")
  })

  test("is forbidden when the file gained another name since it was resolved", async () => {
    const path = box.write("work/a.txt")
    const resolved = await resolveFile("a.txt")
    linkSync(path, join(work, "second-name.txt"))
    expect(
      (await toolFailure(() => stageFile(resolved, '"a.txt"', folder, { used: 0, limit: 1000 }, undefined))).code,
    ).toBe("forbidden")
  })

  test("is stale when the bytes differ from the digest that was approved", async () => {
    box.write("work/a.txt", "hello\n")
    const error = await toolFailure(() => stage("a.txt", "0".repeat(64)))
    expect(error.code).toBe("stale")
    const upper = "5891B5B522D5DF086D0FF0B110FBD9D21BB4FC7163AF34D08286A2E846F6BE03"
    const resolved = await resolveFile("a.txt")
    const staged = await stageFile(resolved, '"a.txt"', join(folder, "1"), { used: 0, limit: 1000 }, upper)
    expect(staged.size).toBe(6)
  })

  test("counts its bytes against the budget of the whole send, refusing the file that passes the limit", async () => {
    box.write("work/a.txt", "x".repeat(60))
    box.write("work/b.txt", "y".repeat(60))
    const budget = { used: 0, limit: 100 }
    const first = await resolveFile("a.txt")
    await stageFile(first, '"a.txt"', join(folder, "0"), budget, undefined)
    expect(budget.used).toBe(60)
    const second = await resolveFile("b.txt")
    const error = await toolFailure(() => stageFile(second, '"b.txt"', join(folder, "1"), budget, undefined))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("100 bytes")
  })

  test("the limit is told in MiB when it is whole MiB", async () => {
    box.write("work/a.txt", "x")
    const resolved = await resolveFile("a.txt")
    const error = await toolFailure(() =>
      stageFile(
        resolved,
        '"a.txt"',
        join(folder, "0"),
        { used: 100 * 1024 * 1024, limit: 100 * 1024 * 1024 },
        undefined,
      ),
    )
    expect(error.message).toContain("100 MiB")
  })

  test.skipIf(!canMakeFifo())(
    "ends at once for a FIFO put where the file was, instead of waiting for a writer",
    async () => {
      const path = box.write("work/a.txt")
      const resolved = await resolveFile("a.txt")
      rmSync(path)
      makeFifo(path)
      const started = Date.now()
      const error = await toolFailure(() =>
        stageFile(resolved, '"a.txt"', join(folder, "0"), { used: 0, limit: 1000 }, undefined),
      )
      expect(Date.now() - started).toBeLessThan(2000)
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toBe('"a.txt" is not a regular file.')
      expect(existsSync(join(folder, "0", "a.txt"))).toBe(false)
    },
  )

  test("never writes through a link where its folder belongs", async () => {
    box.write("work/a.txt")
    mkdirSync(box.mkdir("elsewhere"), { recursive: true })
    const link = join(folder, "0")
    symlinkSync(join(box.root, "elsewhere"), link)
    await expect(stage("a.txt")).rejects.toThrow()
  })
})
