import { afterAll, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import type { ArchiveFormat } from "./kind"
import { DEFAULT_LIMITS, type ArchiveLimits } from "./limits"
import { TAR_BLOCK, buildTar, paxEntry, tarEntry, tarHeader, type TarEntry } from "./tar.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const refuseBytes = (bytes: Buffer, format: ArchiveFormat = "tar", limits?: ArchiveLimits) =>
  refusal(() => inspectArchive(fixtures.write(format === "tar" ? "h.tar" : "h.tgz", bytes), format, limits))
const refuseTar = (parts: Array<TarEntry | Buffer>, limits?: ArchiveLimits) =>
  refuseBytes(buildTar(parts), "tar", limits)

describe("a tar with an entry that is not a plain file", () => {
  test.each([
    ["a hard link", "1", "a hard link"],
    ["a symbolic link", "2", "a symbolic link"],
    ["a character device", "3", "a device file"],
    ["a block device", "4", "a device file"],
    ["a named pipe", "6", "a named pipe"],
    ["a contiguous file", "7", "a contiguous file"],
    ["a sparse file", "S", "a sparse file"],
    ["a file of an unknown type", "Z", "of a type that cannot be read (0x5a)"],
  ])("refuses %s", async (_label, type, reason) => {
    const error = await refuseTar([
      { name: "ok.txt", data: "a" },
      { name: "odd", type, linkname: "ok.txt" },
    ])
    expect(error.entry).toBe("odd")
    expect(error.reason).toContain(reason)
  })

  test("refuses a GNU long link name", async () => {
    const error = await refuseTar([tarEntry({ name: "././@LongLink", type: "K", data: "target\0" })])
    expect(error.reason).toBe("the archive holds a link")
  })

  test("refuses a file named like a directory, and a directory that holds data", async () => {
    expect((await refuseTar([{ name: "dir/", data: "a" }])).reason).toBe("a file named like a directory")
    expect((await refuseTar([{ name: "dir", type: "5", size: 4 }])).reason).toBe("a directory that holds data")
  })
})

describe("a tar whose extended headers say something it cannot accept", () => {
  test("refuses a sparse file made by a pax header", async () => {
    const error = await refuseTar([paxEntry({ "GNU.sparse.size": "10" }), { name: "a", data: "a" }])
    expect(error.reason).toBe("the archive holds a sparse file")
  })

  test("refuses names in another character set", async () => {
    const error = await refuseTar([paxEntry({ hdrcharset: "BINARY" }), { name: "a", data: "a" }])
    expect(error.reason).toContain("other than UTF-8")
  })

  test("refuses a global header that sets a path or size", async () => {
    for (const key of ["path", "size", "linkpath"]) {
      const error = await refuseTar([paxEntry({ [key]: "x" }, "g"), { name: "a", data: "a" }])
      expect(error.reason).toBe("the archive sets a path or size for every entry")
    }
  })

  test("refuses a malformed pax header", async () => {
    const bad = tarEntry({ name: "PaxHeader", type: "x", data: "99 path=short\n" })
    expect((await refuseTar([bad, { name: "a", data: "a" }])).message).toContain("damaged")
  })

  test("refuses a pax size that is not a number", async () => {
    const error = await refuseTar([paxEntry({ size: "12x" }), { name: "a", data: "a" }])
    expect(error.message).toContain("size of a is not a number")
  })

  test("refuses an extended header too large to be one", async () => {
    const huge = tarEntry({ name: "PaxHeader", type: "x", data: Buffer.alloc(70_000), size: 70_000 })
    expect((await refuseTar([huge, { name: "a", data: "a" }])).message).toContain("too large")
  })

  test("refuses a name that is not UTF-8", async () => {
    const error = await refuseTar([{ name: Buffer.from([0x61, 0xff, 0x62]), data: "a" }])
    expect(error.reason).toBe("named with bytes that are not valid UTF-8")
    expect(error.entry).toBe("a\uFFFDb")
  })
})

describe("a tar that is damaged", () => {
  const good = () =>
    buildTar([
      { name: "a.txt", data: "hello" },
      { name: "b.txt", data: "world" },
    ])

  test("refuses a bad header checksum", async () => {
    const error = await refuseTar([
      { name: "a.txt", data: "a" },
      { name: "b.txt", data: "b", badChecksum: true },
    ])
    expect(error.message).toContain("checksum")
  })

  test("refuses bytes that are no tar at all", async () => {
    expect((await refuseBytes(Buffer.alloc(2048, 0x61))).message).toContain("not a tar archive")
    expect((await refuseBytes(Buffer.from("short text"))).message).toContain("not a tar archive")
    expect((await refuseBytes(Buffer.alloc(0))).message).toContain("not a tar archive")
  })

  test("refuses an archive cut inside a file's data", async () => {
    const bytes = good()
    expect((await refuseBytes(bytes.subarray(0, TAR_BLOCK + 2))).message).toContain("ends early")
  })

  test("refuses an archive cut inside a header, and one cut before its end", async () => {
    const bytes = good()
    expect((await refuseBytes(bytes.subarray(0, 3 * TAR_BLOCK + 100))).message).toContain("ends early")
    expect((await refuseBytes(bytes.subarray(0, 4 * TAR_BLOCK))).message).toContain("ends early")
  })

  test("refuses an end marker that is only one block", async () => {
    const bytes = good()
    expect((await refuseBytes(bytes.subarray(0, 4 * TAR_BLOCK + TAR_BLOCK))).message).toContain("ends early")
  })

  test("refuses an entry whose header says it holds more than the archive does", async () => {
    const lying = Buffer.concat([tarHeader({ name: "a.txt", size: 100_000 }), Buffer.alloc(1024)])
    expect((await refuseBytes(lying)).message).toContain("ends early")
  })

  test("refuses a size beyond what can be counted", async () => {
    const error = await refuseTar([{ name: "a.txt", data: "a", size: Buffer.from("ffffffffffff", "hex") }])
    expect(error.message).toContain("size")
  })
})

describe("a tar with too much in it", () => {
  test("refuses more entries than the limit", async () => {
    const parts = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}`, data: "a" }))
    const error = await refuseTar(parts, { ...DEFAULT_LIMITS, maxEntries: 2 })
    expect(error.message).toBe("the archive has more than 2 entries")
  })

  test("refuses 501 entries at the default limit", async () => {
    const parts = Array.from({ length: 501 }, (_, i) => ({ name: `d${i}`, type: "5" }))
    expect((await refuseTar(parts)).message).toBe("the archive has more than 500 entries")
  })

  test("refuses a size larger than the limit before reading it", async () => {
    const lying = Buffer.concat([tarHeader({ name: "a.bin", size: 1_000_000 }), Buffer.alloc(1024)])
    const error = await refuseBytes(lying, "tar", { ...DEFAULT_LIMITS, maxTotalSize: 1000 })
    expect(error.reason).toContain("more than 1000 bytes")
  })

  test("cuts off a gzipped bomb by the bytes it produces", async () => {
    const bomb = gzipSync(buildTar([{ name: "zeros.bin", data: Buffer.alloc(4 * 1024 * 1024) }]))
    expect(bomb.length).toBeLessThan(10_000)
    const error = await refuseBytes(bomb, "tgz", { ...DEFAULT_LIMITS, maxTotalSize: 100 * 1024 })
    expect(error.reason).toBe("the archive unpacks to more than 102400 bytes")
  })

  test("cuts off a gzipped tar whose headers alone grow without end", async () => {
    const limits = { ...DEFAULT_LIMITS, maxMetadata: 4096 }
    const pax = paxEntry({ comment: "x" }, "g")
    const endless = gzipSync(Buffer.concat(Array.from({ length: 4000 }, () => pax)))
    const error = await refuseBytes(endless, "tgz", limits)
    expect(error.reason).toBe("the archive's headers and padding take more than 4096 bytes")
  })
})

describe("a gzip that is not a gzipped tar", () => {
  test("refuses gzip of text and gzip of nothing", async () => {
    expect((await refuseBytes(gzipSync("just some text"), "tgz")).message).toContain("not a tar archive")
    expect((await refuseBytes(gzipSync(""), "tgz")).message).toContain("not a tar archive")
  })

  test("refuses gzip of a longer non-tar", async () => {
    expect((await refuseBytes(gzipSync(Buffer.alloc(5000, 0x62)), "tgz")).message).toContain("not a tar archive")
  })

  test("refuses a gzip that is cut short or corrupt", async () => {
    const bytes = gzipSync(buildTar([{ name: "a.txt", data: "a".repeat(5000) }]))
    expect((await refuseBytes(bytes.subarray(0, bytes.length - 12), "tgz")).message).toContain("damaged")
    const corrupt = Buffer.from(bytes)
    corrupt[corrupt.length - 6] ^= 0xff
    expect((await refuseBytes(corrupt, "tgz")).message).toContain("damaged")
    expect((await refuseBytes(Buffer.from("not gzip at all, only text"), "tgz")).message).toContain("damaged")
  })
})
