import { afterAll, describe, expect, test } from "bun:test"
import { createFixtures } from "./archive.testing"
import { inspectArchive } from "./inspect"
import { buildZip, type ZipEntry } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const inspectZip = (entries: ZipEntry[], options?: Parameters<typeof buildZip>[1]) =>
  inspectArchive(fixtures.write("a.zip", buildZip(entries, options)), "zip")

describe("inspecting a zip", () => {
  test("lists stored and deflated files and directories in the archive's order", async () => {
    const listing = await inspectZip([
      { name: "docs", dir: true },
      { name: "docs/readme.txt", data: "hello", method: "stored" },
      { name: "docs/notes.txt", data: "x".repeat(10_000) },
      { name: "empty.txt", data: "" },
    ])
    expect(listing).toEqual({
      format: "zip",
      entries: [
        { name: "docs/", size: 0, dir: true },
        { name: "docs/readme.txt", size: 5 },
        { name: "docs/notes.txt", size: 10_000 },
        { name: "empty.txt", size: 0 },
      ],
      files: 3,
      total_size: 10_005,
    })
  })

  test("accepts an archive with nothing in it", async () => {
    expect(await inspectZip([])).toEqual({ format: "zip", entries: [], files: 0, total_size: 0 })
  })

  test("reads a UTF-8 name, flagged or not", async () => {
    const listing = await inspectZip([
      { name: "日本語/ファイル.txt", data: "a" },
      { name: Buffer.from("café.txt"), data: "b", utf8: false },
    ])
    expect(listing.entries.map((entry) => entry.name)).toEqual(["日本語/ファイル.txt", "café.txt"])
  })

  test("reads a name that is not UTF-8 as code page 437", async () => {
    const listing = await inspectZip([
      { name: Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]), utf8: false },
    ])
    expect(listing.entries[0]!.name).toBe("café.txt")
  })

  test("reads a zip64 entry and a zip64 end record", async () => {
    const listing = await inspectZip(
      [
        { name: "big.txt", data: "abc", zip64: true },
        { name: "small.txt", data: "de" },
      ],
      { zip64: true },
    )
    expect(listing.entries).toEqual([
      { name: "big.txt", size: 3 },
      { name: "small.txt", size: 2 },
    ])
  })

  test("reads a zip with a comment", async () => {
    expect((await inspectZip([{ name: "a.txt", data: "a" }], { comment: "made by a test" })).files).toBe(1)
  })

  test("accepts source code as text", async () => {
    const listing = await inspectZip([
      { name: "run.bat", data: "@echo off\r\n" },
      { name: "build.ps1", data: "Write-Host hi" },
      { name: "app.js", data: "console.log(1)" },
      { name: "setup.sh", data: "#!/bin/sh\necho hi\n" },
    ])
    expect(listing.files).toBe(4)
  })

  test("counts the bytes it reads, one chunk after another, for a large entry", async () => {
    const listing = await inspectZip([{ name: "large.bin", data: Buffer.alloc(300_000, 0x61) }])
    expect(listing.total_size).toBe(300_000)
  })
})
