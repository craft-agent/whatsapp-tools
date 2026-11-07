import { afterAll, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import type { ArchiveFormat } from "./kind"
import { DEFAULT_LIMITS, MAX_INPUT_SIZE, MAX_METADATA_SIZE, MAX_TOTAL_SIZE, type ArchiveLimits } from "./limits"
import { buildTar, type TarEntry } from "./tar.testing"
import { buildZip } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

/** Two files of 10 and 5 bytes, and a directory, in each format. */
const FILES = { total: 15 }
const files = [
  { name: "d", dir: true },
  { name: "d/a.bin", data: "a".repeat(10) },
  { name: "d/b.bin", data: "b".repeat(5) },
]
const tarParts: TarEntry[] = files.map((f) => (f.dir ? { name: f.name, type: "5" } : { name: f.name, data: f.data }))

const archives: Array<[ArchiveFormat, () => Buffer]> = [
  ["zip", () => buildZip(files)],
  ["tar", () => buildTar(tarParts)],
  ["tgz", () => gzipSync(buildTar(tarParts))],
]

const inspect = (format: ArchiveFormat, bytes: Buffer, limits: Partial<ArchiveLimits>) =>
  inspectArchive(fixtures.write(`l.${format}`, bytes), format, { ...DEFAULT_LIMITS, ...limits })

describe.each(archives)("the file budget of a %s", (format, make) => {
  test("is spent on entry data alone, so data exactly at the limit passes", async () => {
    const listing = await inspect(format, make(), { maxTotalSize: FILES.total })
    expect(listing.total_size).toBe(FILES.total)
  })

  test("refuses one byte over the limit", async () => {
    const error = await refusal(() => inspect(format, make(), { maxTotalSize: FILES.total - 1 }))
    expect(error.reason).toBe("the archive unpacks to more than 14 bytes")
  })

  test("passes an archive with no data under a limit of 0", async () => {
    const empty = format === "zip" ? buildZip([{ name: "d", dir: true }]) : buildTar([{ name: "d", type: "5" }])
    const bytes = format === "tgz" ? gzipSync(empty) : empty
    expect((await inspect(format, bytes, { maxTotalSize: 0 })).files).toBe(0)
  })
})

describe("the metadata budget of a tar", () => {
  test("lets an empty tar pass under any file limit", async () => {
    const empty: Array<[ArchiveFormat, Buffer]> = [
      ["tar", buildTar([])],
      ["tgz", gzipSync(buildTar([]))],
      ["zip", buildZip([])],
    ]
    for (const [format, bytes] of empty) {
      expect((await inspect(format, bytes, { maxTotalSize: 0 })).entries).toEqual([])
    }
  })

  test("is spent on headers, padding and zeros, and refuses past its own limit", async () => {
    const tar = buildTar(tarParts)
    expect((await inspect("tar", tar, { maxMetadata: tar.length - FILES.total })).files).toBe(2)
    const error = await refusal(() => inspect("tar", tar, { maxMetadata: tar.length - FILES.total - 1 }))
    expect(error.reason).toBe(`the archive's headers and padding take more than ${tar.length - FILES.total - 1} bytes`)
  })

  test("does not touch the file budget, whatever the headers cost", async () => {
    const tar = buildTar(tarParts)
    const roomy = await inspect("tar", tar, { maxTotalSize: FILES.total, maxMetadata: tar.length })
    expect(roomy.total_size).toBe(FILES.total)
  })
})

describe("the size of the archive file", () => {
  test("is held to maxInputSize before any of it is read", async () => {
    for (const [format, make] of archives) {
      const bytes = make()
      expect((await inspect(format, bytes, { maxInputSize: bytes.length })).files).toBe(2)
      const error = await refusal(() => inspect(format, bytes, { maxInputSize: bytes.length - 1 }))
      expect(error.reason).toBe(`the archive file is larger than ${bytes.length - 1} bytes`)
    }
  })

  test("refuses a file of garbage that is over the cap without reading it as an archive", async () => {
    const error = await refusal(() => inspect("tgz", Buffer.alloc(5000, 0x41), { maxInputSize: 4096 }))
    expect(error.reason).toBe("the archive file is larger than 4096 bytes")
  })

  test("is the file budget and the metadata budget together by default", () => {
    expect(MAX_INPUT_SIZE).toBe(MAX_TOTAL_SIZE + MAX_METADATA_SIZE)
    expect(DEFAULT_LIMITS).toEqual({
      maxEntries: 500,
      maxTotalSize: 500 * 1024 * 1024,
      maxMetadata: 16 * 1024 * 1024,
      maxInputSize: 516 * 1024 * 1024,
    })
  })
})
