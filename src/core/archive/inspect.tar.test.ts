import { afterAll, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { createFixtures } from "./archive.testing"
import { inspectArchive } from "./inspect"
import type { ArchiveFormat } from "./kind"
import { TAR_END, base256, buildTar, longNameEntry, paxEntry, tarEntry, type TarEntry } from "./tar.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const inspectTar = (parts: Array<TarEntry | Buffer>, format: ArchiveFormat = "tar") => {
  const tar = buildTar(parts)
  return inspectArchive(fixtures.write("a.tar", format === "tgz" ? gzipSync(tar) : tar), format)
}

describe.each<ArchiveFormat>(["tar", "tgz"])("inspecting a %s", (format) => {
  test("lists files and directories in the archive's order", async () => {
    const listing = await inspectTar(
      [
        { name: "docs", type: "5" },
        { name: "docs/readme.txt", data: "hello" },
        { name: "docs/old.txt", data: "abc", type: "\0" },
        { name: "big.txt", data: "x".repeat(1000) },
        { name: "empty.txt" },
      ],
      format,
    )
    expect(listing).toEqual({
      format,
      entries: [
        { name: "docs/", size: 0, dir: true },
        { name: "docs/readme.txt", size: 5 },
        { name: "docs/old.txt", size: 3 },
        { name: "big.txt", size: 1000 },
        { name: "empty.txt", size: 0 },
      ],
      files: 4,
      total_size: 1008,
    })
  })

  test("accepts an archive with nothing in it", async () => {
    expect(await inspectTar([], format)).toEqual({ format, entries: [], files: 0, total_size: 0 })
  })

  test("reads a long name from a pax header", async () => {
    const name = `${"deep/".repeat(40)}file.txt`
    const listing = await inspectTar([paxEntry({ path: name }), { name: "short", data: "a" }], format)
    expect(listing.entries).toEqual([{ name, size: 1 }])
  })

  test("reads a size from a pax header over the one in the header", async () => {
    const listing = await inspectTar([paxEntry({ size: "3" }), { name: "a.txt", data: "abc", size: 0 }], format)
    expect(listing.entries).toEqual([{ name: "a.txt", size: 3 }])
  })

  test("reads a long name from a GNU header", async () => {
    const name = `${"long-directory-name/".repeat(10)}file.txt`
    const listing = await inspectTar([longNameEntry(name), { name: "truncated", data: "a", magic: "gnu" }], format)
    expect(listing.entries).toEqual([{ name, size: 1 }])
  })

  test("joins a ustar prefix to the name", async () => {
    const listing = await inspectTar([{ name: "file.txt", prefix: "some/dir", data: "a" }], format)
    expect(listing.entries[0]!.name).toBe("some/dir/file.txt")
  })

  test("reads a size written in base-256", async () => {
    const listing = await inspectTar([{ name: "a.txt", data: "abcd", size: base256(4) }], format)
    expect(listing.entries).toEqual([{ name: "a.txt", size: 4 }])
  })

  test("reads a UTF-8 name and an old header with no magic", async () => {
    const listing = await inspectTar(
      [
        { name: "日本語.txt", data: "a" },
        { name: "v7.txt", data: "b", magic: "v7" },
      ],
      format,
    )
    expect(listing.entries.map((entry) => entry.name)).toEqual(["日本語.txt", "v7.txt"])
  })

  test("accepts a global pax header that only carries a comment, as source archives do", async () => {
    const listing = await inspectTar(
      [paxEntry({ comment: "52c0d6e7f6e8d0e8b0b6f1b5a1d4d3c2b1a09f8e" }, "g"), { name: "a.txt", data: "a" }],
      format,
    )
    expect(listing.files).toBe(1)
  })

  test("accepts source code as text", async () => {
    const listing = await inspectTar(
      [
        { name: "run.cmd", data: "@echo off" },
        { name: "tool.py", data: "print(1)" },
      ],
      format,
    )
    expect(listing.files).toBe(2)
  })
})

describe("inspecting a gzipped tar", () => {
  test("reads gzip members one after another as a single stream", async () => {
    const tar = buildTar([{ name: "a.txt", data: "a".repeat(1000) }])
    const half = 512
    const bytes = Buffer.concat([gzipSync(tar.subarray(0, half)), gzipSync(tar.subarray(half))])
    const listing = await inspectArchive(fixtures.write("members.tgz", bytes), "tgz")
    expect(listing.entries).toEqual([{ name: "a.txt", size: 1000 }])
  })

  test("ignores what follows the end of the tar", async () => {
    const bytes = Buffer.concat([tarEntry({ name: "a.txt", data: "a" }), TAR_END, Buffer.alloc(8192)])
    const listing = await inspectArchive(fixtures.write("padded.tar", bytes), "tar")
    expect(listing.entries).toEqual([{ name: "a.txt", size: 1 }])
  })
})
