import { afterAll, describe, expect, test } from "bun:test"
import { crc32, deflateRawSync } from "node:zlib"
import { createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import { DEFAULT_LIMITS, type ArchiveLimits } from "./limits"
import { buildZip, type ZipEntry, type ZipOptions } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const refuseBytes = (bytes: Buffer, limits?: ArchiveLimits) =>
  refusal(() => inspectArchive(fixtures.write("hostile.zip", bytes), "zip", limits))
const refuseZip = (entries: ZipEntry[], options?: ZipOptions, limits?: ArchiveLimits) =>
  refuseBytes(buildZip(entries, options), limits)

const mode = (type: number) => ((type << 12) | 0o644) * 65536

describe("a zip with an entry that is not a plain file", () => {
  test.each([
    ["a symbolic link", mode(0o12), "a symbolic link"],
    ["a character device", mode(0o02), "a special file"],
    ["a block device", mode(0o06), "a special file"],
    ["a named pipe", mode(0o01), "a special file"],
    ["a socket", mode(0o14), "a special file"],
  ])("refuses %s", async (_label, attributes, reason) => {
    const error = await refuseZip([
      { name: "ok.txt", data: "a" },
      { name: "link", data: "ok.txt", attributes },
    ])
    expect(error.entry).toBe("link")
    expect(error.reason).toContain(reason)
    expect(error.message).toStartWith("the entry link is ")
  })

  test("refuses a directory marked as one but not named like one", async () => {
    const error = await refuseZip([{ name: "folder", attributes: mode(0o04) }])
    expect(error.reason).toContain("not named like one")
  })

  test("refuses a directory that holds data", async () => {
    const error = await refuseZip([{ name: "folder/", size: 4 }])
    expect(error.reason).toBe("a directory that holds data")
  })
})

describe("a zip with an entry it cannot read", () => {
  test.each([
    ["encrypted", 0x0001],
    ["strongly encrypted", 0x0040],
    ["encrypted with masked headers", 0x2000],
  ])("refuses an entry that is %s", async (_label, flags) => {
    const error = await refuseZip([{ name: "secret.txt", data: "a", flags }])
    expect(error).toMatchObject({ entry: "secret.txt", reason: "encrypted" })
  })

  test("refuses a compression method other than stored and deflate, naming it", async () => {
    const error = await refuseZip([{ name: "a.bz2.txt", data: "a", method: 12 }])
    expect(error.reason).toContain("method 12")
  })

  test("refuses an entry that carries a second name", async () => {
    const extra = Buffer.from([0x75, 0x70, 0x05, 0x00, 0x01, 0, 0, 0, 0])
    const error = await refuseZip([{ name: "a.txt", data: "a", extra }])
    expect(error.reason).toContain("second name")
  })

  test("refuses a UTF-8 flagged name that is not UTF-8", async () => {
    const error = await refuseZip([{ name: Buffer.from([0x61, 0xff, 0x2e]), data: "a", utf8: true }])
    expect(error.reason).toContain("not valid UTF-8")
  })
})

describe("a zip whose sizes or checksums lie", () => {
  test("refuses an entry that is larger than the central directory says", async () => {
    const error = await refuseZip([{ name: "a.txt", data: "x".repeat(1000), size: 10 }])
    expect(error).toMatchObject({ entry: "a.txt", reason: "larger than the archive says" })
  })

  test("refuses an entry that is smaller than the central directory says", async () => {
    const error = await refuseZip([{ name: "a.txt", data: "x".repeat(10), size: 1000 }])
    expect(error).toMatchObject({ entry: "a.txt", reason: "smaller than the archive says" })
  })

  test("refuses a stored entry whose two sizes differ", async () => {
    const error = await refuseZip([{ name: "a.txt", data: "abcd", method: "stored", size: 2 }])
    expect(error.message).toContain("sizes of a.txt disagree")
  })

  test("refuses a checksum that does not match", async () => {
    const error = await refuseZip([{ name: "a.txt", data: "abc", crc: 0x12345678 }])
    expect(error).toMatchObject({ entry: "a.txt", reason: "damaged (its checksum does not match)" })
  })

  test("refuses deflated data that is cut short", async () => {
    const text = "x".repeat(500).split("").join("yz")
    const cut = deflateRawSync(text).subarray(0, 10)
    const error = await refuseZip([{ name: "a.txt", data: cut, method: 8, size: text.length, crc: crc32(text) }])
    expect(error).toMatchObject({ entry: "a.txt" })
    expect(error.reason).toStartWith("damaged (")
  })

  test("refuses a local header that disagrees with the central one", async () => {
    expect((await refuseZip([{ name: "a.txt", data: "a", localName: "b.txt" }])).message).toContain("disagree")
  })
})

describe("a zip bomb", () => {
  const bomb = Buffer.alloc(2 * 1024 * 1024)

  test("is cut off at the limit by the bytes it produces", async () => {
    const limits = { ...DEFAULT_LIMITS, maxTotalSize: 100 * 1024 }
    const error = await refuseZip([{ name: "zeros.bin", data: bomb }], undefined, limits)
    expect(error.reason).toBe("the archive unpacks to more than 102400 bytes")
  })

  test("is cut off by its declared size before any of it is read", async () => {
    const limits = { ...DEFAULT_LIMITS, maxTotalSize: 1024 }
    const error = await refuseZip([{ name: "a.bin", data: "x".repeat(2000), method: "stored" }], undefined, limits)
    expect(error.reason).toContain("more than 1024 bytes")
  })

  test("is cut off when the entries add up past the limit", async () => {
    const limits = { ...DEFAULT_LIMITS, maxTotalSize: 150 }
    const error = await refuseZip(
      [
        { name: "a.bin", data: "x".repeat(100) },
        { name: "b.bin", data: "y".repeat(100) },
      ],
      undefined,
      limits,
    )
    expect(error.reason).toContain("more than 150 bytes")
  })

  test("counts what an entry that declares less really produces", async () => {
    const limits = { ...DEFAULT_LIMITS, maxTotalSize: 100 * 1024 }
    const error = await refuseZip([{ name: "zeros.bin", data: bomb, size: 50 * 1024 }], undefined, limits)
    expect(error.reason).toBe("larger than the archive says")
  })
})

describe("a zip with too many entries", () => {
  test("refuses more than the limit, before reading any data", async () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.txt`, data: "a" }))
    const error = await refuseZip(entries, undefined, { ...DEFAULT_LIMITS, maxEntries: 2 })
    expect(error.message).toBe("the archive has more than 2 entries")
  })

  test("refuses 501 entries at the default limit, directories counted", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({ name: `d${i}`, dir: true }))
    expect((await refuseZip(entries)).message).toBe("the archive has more than 500 entries")
  })

  test("accepts exactly 500", async () => {
    const entries = Array.from({ length: 500 }, (_, i) => ({ name: `d${i}`, dir: true }))
    const listing = await inspectArchive(fixtures.write("full.zip", buildZip(entries)), "zip")
    expect(listing.entries).toHaveLength(500)
  })
})

describe("a damaged or tampered zip", () => {
  const good = () =>
    buildZip([
      { name: "a.txt", data: "hello" },
      { name: "b.txt", data: "world" },
    ])

  test("refuses entries that overlap", async () => {
    const error = await refuseZip([
      { name: "a.txt", data: "hello" },
      { name: "a.txt", data: "hello", localOffset: 0 },
    ])
    expect(error.reason).toBe("overlapping another entry")
  })

  test("refuses a local header outside the file", async () => {
    const error = await refuseZip([{ name: "a.txt", data: "hello", localOffset: 1_000_000 }])
    expect(error.message).toContain("header of a.txt is missing")
  })

  test("refuses a central directory that points outside the file", async () => {
    const bytes = good()
    bytes.writeUInt32LE(bytes.length + 100, bytes.length - 22 + 16)
    expect((await refuseBytes(bytes)).message).toContain("damaged")
  })

  test("refuses a central directory with a gap before the end record", async () => {
    const bytes = good()
    const sizeAt = bytes.length - 22 + 12
    bytes.writeUInt32LE(bytes.readUInt32LE(sizeAt) - 1, sizeAt)
    expect((await refuseBytes(bytes)).message).toContain("damaged")
  })

  test("refuses a zip that is cut short", async () => {
    const bytes = good()
    expect((await refuseBytes(bytes.subarray(0, bytes.length - 10))).message).toContain("damaged")
    expect((await refuseBytes(bytes.subarray(0, 20))).message).toContain("damaged")
  })

  test("refuses bytes that are no zip at all", async () => {
    expect((await refuseBytes(Buffer.from("this is only text, long enough to hold a record end"))).message).toContain(
      "damaged",
    )
  })

  test("refuses data after the end record", async () => {
    expect((await refuseBytes(Buffer.concat([good(), Buffer.from("junk")]))).message).toContain("damaged")
  })

  test("refuses an archive split over several disks", async () => {
    const bytes = good()
    bytes.writeUInt16LE(1, bytes.length - 22 + 4)
    expect((await refuseBytes(bytes)).message).toContain("several files")
  })

  test("refuses a record end that needs zip64 but has none", async () => {
    const bytes = good()
    bytes.writeUInt32LE(0xffffffff, bytes.length - 22 + 16)
    expect((await refuseBytes(bytes)).message).toContain("damaged")
  })
})
