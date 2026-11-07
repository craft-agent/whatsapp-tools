import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openStaged } from "./staged"

let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "staged-"))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

describe("opening the file a download wrote", () => {
  test("opens a regular file", async () => {
    writeFileSync(join(folder, "file"), "bytes")
    const handle = await openStaged(join(folder, "file"))
    expect((await handle.readFile()).toString()).toBe("bytes")
    await handle.close()
  })

  test.each([
    ["a file that is not there", () => {}],
    ["a folder", () => mkdirSync(join(folder, "file"))],
    [
      "a link to a file",
      () => (writeFileSync(join(folder, "real"), "x"), symlinkSync(join(folder, "real"), join(folder, "file"))),
    ],
    ["a dangling link", () => symlinkSync(join(folder, "nowhere"), join(folder, "file"))],
  ])("refuses %s as upstream_error, naming no path", async (_what, arrange) => {
    arrange()
    const error = await openStaged(join(folder, "file")).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "upstream_error" })
    expect((error as Error).message).not.toContain(folder)
  })
})
