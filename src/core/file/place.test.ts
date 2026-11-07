import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyToPartial, placeFile } from "./place"

let folder: string
let source: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "place-"))
  source = join(folder, "..", `source-${Date.now()}-${Math.random()}`)
  writeFileSync(source, "the bytes that were inspected")
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(source, { force: true })
})

async function copied() {
  const handle = await open(source, "r")
  try {
    return await copyToPartial(handle, folder)
  } finally {
    await handle.close()
  }
}

describe("placing a partial", () => {
  test("places the file that was written", async () => {
    const partial = await copied()
    const placed = await placeFile(partial, folder, "x.txt")
    expect(placed).toMatchObject({ name: "x.txt", alreadySaved: false })
    expect(readdirSync(folder)).toEqual(["x.txt"])
  })

  test("refuses a partial that has been replaced by another file since it was written", async () => {
    const partial = await copied()
    // made while the first still exists, so it cannot share its inode number
    const other = join(folder, "other")
    writeFileSync(other, "the bytes that were inspected")
    renameSync(other, partial.partial)
    await expect(placeFile(partial, folder, "x.txt")).rejects.toThrow("changed before it was placed")
    expect(readdirSync(folder)).not.toContain("x.txt")
  })

  test("refuses a partial that has been appended to", async () => {
    const partial = await copied()
    writeFileSync(partial.partial, "the bytes that were inspected, and more", { flag: "a" })
    await expect(placeFile(partial, folder, "x.txt")).rejects.toThrow("changed before it was placed")
    expect(readFileSync(partial.partial, "utf8")).toContain("and more")
  })
})
