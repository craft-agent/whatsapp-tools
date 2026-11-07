import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildZip, type ZipEntry } from "../archive/zip.testing"
import { RESULT_BUDGET } from "../pages"
import { fitListing } from "./result"
import { createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"
import type { FileSaveOutput } from "./schema"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
})
afterEach(() => t.close())

/** `count` small files with long names, so that their listing alone is over the budget when there are 500. */
function entries(count: number, prefix = "entry"): ZipEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${String(i).padStart(3, "0")}-${"n".repeat(100)}.txt`,
    data: "x",
  }))
}

async function saveZip(name: string, zipEntries: ZipEntry[], type = "") {
  t.message({ name, type })
  t.respond(download(buildZip(zipEntries)))
  return t.save(saveArgs())
}

describe("a result that is too long for the budget", () => {
  test("cuts the listing of a 500-entry archive to its first entries, and says so", async () => {
    const result = await saveZip("big.zip", entries(500))

    const listing = result.file!.archive!
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESULT_BUDGET)
    expect(listing.entries_cut).toBe(true)
    expect(listing.entries.length).toBeGreaterThan(100)
    expect(listing.entries.length).toBeLessThan(500)
    expect(listing.entries[0]!.name.startsWith("entry-000-")).toBe(true)
    expect(listing.entries.at(-1)!.name).toContain(`entry-${String(listing.entries.length - 1).padStart(3, "0")}-`)
    expect(listing.files).toBe(500)
    expect(listing.total_size).toBe(500)
  })

  test("leaves a listing that fits whole, without entries_cut", async () => {
    const listing = (await saveZip("small.zip", entries(20))).file!.archive!
    expect(listing.entries).toHaveLength(20)
    expect(listing.entries_cut).toBeUndefined()
  })
})

describe("fitListing", () => {
  const resultOf = (count: number, name: string): FileSaveOutput => ({
    chat: "c",
    id: "i",
    folder: "/f",
    note: "n",
    file: {
      name: "a.zip",
      path: "/f/a.zip",
      size: 1,
      sha256: "0".repeat(64),
      archive: {
        format: "zip",
        files: count,
        total_size: count,
        entries: Array.from({ length: count }, (_, i) => ({ name: `${name}-${i}-${"y".repeat(120)}`, size: 1 })),
      },
    },
  })

  test("changes nothing for a result within the budget", () => {
    const result = resultOf(10, "a")
    const before = JSON.stringify(result)
    expect(JSON.stringify(fitListing(result))).toBe(before)
  })

  test("changes nothing for a result with no archive", () => {
    const result: FileSaveOutput = { chat: "c", id: "i", folder: "/f", note: "n", refused: { name: "a", reason: "b" } }
    expect(fitListing(result)).toEqual({
      chat: "c",
      id: "i",
      folder: "/f",
      note: "n",
      refused: { name: "a", reason: "b" },
    })
  })

  test("keeps the count of files and the total size, and the entries it keeps are the first ones", () => {
    const archive = fitListing(resultOf(500, "x")).file!.archive!
    expect(archive.entries_cut).toBe(true)
    expect(archive.files).toBe(500)
    expect(archive.total_size).toBe(500)
    expect(archive.entries[0]!.name.startsWith("x-0-")).toBe(true)
    expect(archive.entries[1]!.name.startsWith("x-1-")).toBe(true)
  })
})

describe("what the sender chooses stays within the budget", () => {
  test("a declared content type is cut to 100 characters in the result, without splitting a character", async () => {
    t.respond(download("x"))
    t.message({ name: "a.bin", type: `application/x-${"long".repeat(100)}` })
    expect((await t.save(saveArgs())).file!.type).toBe(`application/x-${"long".repeat(100)}`.slice(0, 100))
    t.message({ name: "b.bin", type: `${"t".repeat(99)}😀 and more` })
    expect((await t.save(saveArgs())).file!.type).toBe("t".repeat(99))
  })

  test("a short content type is kept as it is", async () => {
    t.respond(download("x"))
    t.message({ name: "a.txt", type: "text/plain; charset=utf-8" })
    expect((await t.save(saveArgs())).file!.type).toBe("text/plain; charset=utf-8")
  })
})
