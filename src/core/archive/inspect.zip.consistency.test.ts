import { afterAll, describe, expect, test } from "bun:test"
import { crc32, deflateRawSync } from "node:zlib"
import { createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import { buildZip, zip64LocalExtra, type ZipDescriptor, type ZipEntry, type ZipOptions } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const inspectZip = (entries: ZipEntry[], options?: ZipOptions) =>
  inspectArchive(fixtures.write("c.zip", buildZip(entries, options)), "zip")
const refuseZip = (entries: ZipEntry[], options?: ZipOptions) => refusal(() => inspectZip(entries, options))

const UNACCOUNTED = "the archive holds data its directory does not account for"
const data = "the same bytes, twice over. ".repeat(40)

describe("a local header that does not say what the central directory says", () => {
  test.each([
    ["checksum", { crc: 0x12345678 }],
    ["compressed size", { compressedSize: 7 }],
    ["size", { size: 7 }],
  ])("is refused when its %s differs", async (_label, local) => {
    const error = await refuseZip([{ name: "a.txt", data, local }])
    expect(error.message).toContain("headers of a.txt disagree")
  })

  test("is refused when its method or its descriptor flag differs from the central one", async () => {
    expect((await refuseZip([{ name: "a.txt", data, local: { flags: 0x0008 } }])).message).toContain("disagree")
  })

  test("is accepted when it says the same", async () => {
    expect(
      (
        await inspectZip([
          { name: "a.txt", data },
          { name: "b.txt", data, method: "stored" },
        ])
      ).files,
    ).toBe(2)
  })

  test("is refused when it carries a Unicode path or comment field", async () => {
    const unicodePath = Buffer.from([0x75, 0x70, 0x05, 0x00, 0x01, 0, 0, 0, 0])
    const unicodeComment = Buffer.from([0x75, 0x63, 0x05, 0x00, 0x01, 0, 0, 0, 0])
    expect((await refuseZip([{ name: "a.txt", data, local: { extra: unicodePath } }])).reason).toContain("second name")
    expect((await refuseZip([{ name: "a.txt", data, local: { extra: unicodeComment } }])).reason).toContain(
      "second comment",
    )
  })

  test("is refused when its extra fields are cut short", async () => {
    const error = await refuseZip([{ name: "a.txt", data, local: { extra: Buffer.from([0x0a, 0x00, 0x09, 0x00, 1]) } }])
    expect(error.message).toContain("extra field is cut short")
  })

  test("may carry extra fields it does not need, such as a timestamp", async () => {
    const timestamp = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0, 0, 0, 0])
    expect((await inspectZip([{ name: "a.txt", data, local: { extra: timestamp } }])).files).toBe(1)
  })
})

describe("a local zip64 extra field", () => {
  const size = data.length
  const compressedSize = deflateRawSync(data).length

  test("is accepted when it repeats the central sizes, with the 32-bit fields saturated or not", async () => {
    const extra = zip64LocalExtra(size, compressedSize)
    expect((await inspectZip([{ name: "a.txt", data, local: { extra } }])).files).toBe(1)
    const saturated = { extra, size: 0xffffffff, compressedSize: 0xffffffff }
    expect((await inspectZip([{ name: "a.txt", data, local: saturated }])).files).toBe(1)
  })

  test("is refused when its sizes disagree", async () => {
    const wrongSize = zip64LocalExtra(size + 1, compressedSize)
    const wrongPacked = zip64LocalExtra(size, compressedSize + 1)
    expect((await refuseZip([{ name: "a.txt", data, local: { extra: wrongSize } }])).message).toContain("disagree")
    expect((await refuseZip([{ name: "a.txt", data, local: { extra: wrongPacked } }])).message).toContain("disagree")
  })

  test("is required when a 32-bit field is saturated", async () => {
    const error = await refuseZip([{ name: "a.txt", data, local: { size: 0xffffffff } }])
    expect(error.message).toContain("disagree")
  })

  test("is refused when it is too short to hold both sizes", async () => {
    const short = Buffer.from([0x01, 0x00, 0x08, 0x00, 1, 0, 0, 0, 0, 0, 0, 0])
    expect((await refuseZip([{ name: "a.txt", data, local: { extra: short } }])).message).toContain("cut short")
  })
})

describe("an entry with a data descriptor", () => {
  const forms: Array<[string, ZipDescriptor]> = [
    ["a signed 32-bit descriptor", { signature: true, wide: false }],
    ["a signed 64-bit descriptor", { signature: true, wide: true }],
    ["an unsigned 32-bit descriptor", { signature: false, wide: false }],
    ["an unsigned 64-bit descriptor", { signature: false, wide: true }],
  ]

  test.each(forms)("is accepted with %s, deflated or stored", async (_label, descriptor) => {
    const zip64 = descriptor.wide
    const listing = await inspectZip([
      { name: "a.txt", data, descriptor, zip64 },
      { name: "b.txt", data, method: "stored", descriptor, zip64 },
      { name: "c.txt", data: "after", descriptor, zip64 },
    ])
    expect(listing.entries.map((entry) => entry.size)).toEqual([data.length, data.length, 5])
  })

  test("may hold real values in the local header as well as the descriptor", async () => {
    const local = { crc: crc32(data), size: data.length, compressedSize: deflateRawSync(data).length }
    expect((await inspectZip([{ name: "a.txt", data, descriptor: {}, local }])).files).toBe(1)
  })

  test.each([
    ["checksum", { crc: 1 }],
    ["compressed size", { compressedSize: 3 }],
    ["size", { size: 3 }],
  ])("is refused when its %s disagrees with the central one", async (_label, wrong) => {
    for (const form of forms) {
      const descriptor = { ...form[1], ...wrong }
      const error = await refuseZip([{ name: "a.txt", data, descriptor, zip64: descriptor.wide }])
      expect(error.message).toContain("data descriptor of a.txt")
    }
  })

  test("is refused when the descriptor is missing", async () => {
    const error = await refuseZip([{ name: "a.txt", data, flags: 0x0008, local: { flags: 0x0008 } }])
    expect(error.message).toContain("data descriptor of a.txt")
  })

  test("is refused when the local header has real values that disagree", async () => {
    const error = await refuseZip([{ name: "a.txt", data, descriptor: {}, local: { size: 3 } }])
    expect(error.message).toContain("disagree")
  })

  test("is refused when only the central record has the descriptor flag", async () => {
    const error = await refuseZip([{ name: "a.txt", data, flags: 0x0008, local: { flags: 0 } }])
    expect(error.message).toContain("disagree")
  })

  test("leaves a descriptor the directory knows of no room for other bytes", async () => {
    const junk = Buffer.from("PK\x07\x08 extra bytes")
    const error = await refuseZip([
      { name: "a.txt", data, descriptor: {} },
      { name: "b.txt", data, before: junk },
    ])
    expect(error.reason).toBe(UNACCOUNTED)
  })
})

describe("bytes of the file that no entry accounts for", () => {
  const orphan = () => {
    const zip = buildZip([{ name: "evil.txt", data: "an entry only a scan finds" }])
    return zip.subarray(0, zip.readUInt32LE(zip.length - 6))
  }

  test("data before the first entry is refused", async () => {
    expect((await refuseZip([{ name: "a.txt", data, before: Buffer.from("MZ prepended data") }])).reason).toBe(
      UNACCOUNTED,
    )
  })

  test("bytes between two entries are refused", async () => {
    const error = await refuseZip([
      { name: "a.txt", data },
      { name: "b.txt", data, before: Buffer.from("interleaved") },
    ])
    expect(error.reason).toBe(UNACCOUNTED)
  })

  test("bytes between the last entry and the directory are refused", async () => {
    const error = await refuseZip([{ name: "a.txt", data }], { beforeDirectory: Buffer.from("hidden") })
    expect(error.reason).toBe(UNACCOUNTED)
  })

  test("an orphan local entry the directory does not list is refused, in any place", async () => {
    expect((await refuseZip([{ name: "a.txt", data, before: orphan() }])).reason).toBe(UNACCOUNTED)
    expect((await refuseZip([{ name: "a.txt", data }], { beforeDirectory: orphan() })).reason).toBe(UNACCOUNTED)
    const middle = await refuseZip([
      { name: "a.txt", data },
      { name: "b.txt", data, before: orphan() },
    ])
    expect(middle.reason).toBe(UNACCOUNTED)
  })

  test("a tiled archive is accepted, with zip64 and a comment too", async () => {
    const entries: ZipEntry[] = [
      { name: "d/", dir: true },
      { name: "d/a.txt", data, zip64: true },
      { name: "d/b.txt", data, descriptor: {} },
    ]
    expect((await inspectZip(entries, { zip64: true, comment: "tiled" })).files).toBe(2)
  })

  test("an entry listed out of order in the directory still tiles", async () => {
    const zip = buildZip([
      { name: "a.txt", data },
      { name: "b.txt", data },
    ])
    expect((await inspectArchive(fixtures.write("order.zip", zip), "zip")).files).toBe(2)
  })
})

describe("deflate data that does not end where the entry does", () => {
  const text = "an entry that deflates to a handful of bytes ".repeat(30)
  const packed = deflateRawSync(text)
  const raw = (body: Buffer): ZipEntry => ({
    name: "a.txt",
    data: body,
    method: 8,
    size: text.length,
    crc: crc32(text),
  })

  test("an exact stream is accepted", async () => {
    expect((await inspectZip([raw(packed)])).files).toBe(1)
  })

  test("a stream that finishes early, leaving bytes the entry claims, is refused", async () => {
    const error = await refuseZip([raw(Buffer.concat([packed, Buffer.from("hidden payload after the stream")]))])
    expect(error).toMatchObject({ entry: "a.txt" })
    expect(error.reason).toContain("goes on after the end of the stream")
  })

  test("a stream that needs more bytes than the entry has is refused", async () => {
    const error = await refuseZip([raw(packed.subarray(0, packed.length - 4))])
    expect(error.reason).toStartWith("damaged (")
  })
})
