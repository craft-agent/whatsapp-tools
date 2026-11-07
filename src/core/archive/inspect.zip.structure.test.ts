import { afterAll, describe, expect, test } from "bun:test"
import { deflateRawSync } from "node:zlib"
import { createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import { buildZip, zip64LocalExtra, type ZipEntry, type ZipOptions } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const inspectZip = (entries: ZipEntry[], options?: ZipOptions) =>
  inspectArchive(fixtures.write("s.zip", buildZip(entries, options)), "zip")
const refuseZip = (entries: ZipEntry[], options?: ZipOptions) => refusal(() => inspectZip(entries, options))

const data = "some file data, long enough to deflate to something. ".repeat(20)
const emptyStream = deflateRawSync("")

describe("a directory entry's data", () => {
  const rawDir = (body: Buffer, extra: Partial<ZipEntry> = {}): ZipEntry => ({
    name: "folder/",
    dir: true,
    data: body,
    method: 8,
    size: 0,
    crc: 0,
    ...extra,
  })

  test("a stored directory with compressed bytes but no uncompressed size is refused", async () => {
    const error = await refuseZip([{ name: "folder/", dir: true, data: "junk", size: 0, crc: 0 }])
    expect(error).toMatchObject({ entry: "folder/", reason: "a directory that holds data" })
  })

  test("a deflated directory that inflates to nothing is fine, and so is a stored one", async () => {
    const listing = await inspectZip([
      { name: "deflated/", dir: true, method: "deflate" },
      { name: "stored/", dir: true },
      rawDir(emptyStream, { name: "raw/" }),
    ])
    expect(listing.entries).toEqual([
      { name: "deflated/", size: 0, dir: true },
      { name: "stored/", size: 0, dir: true },
      { name: "raw/", size: 0, dir: true },
    ])
  })

  test("a deflated directory with bytes after its stream is refused", async () => {
    const error = await refuseZip([rawDir(Buffer.concat([emptyStream, Buffer.from("hidden")]))])
    expect(error.entry).toBe("folder/")
    expect(error.reason).toContain("goes on after the end of the stream")
  })

  test("a deflated directory that inflates to bytes is refused", async () => {
    const error = await refuseZip([rawDir(deflateRawSync("hidden payload"))])
    expect(error).toMatchObject({ entry: "folder/", reason: "larger than the archive says" })
  })

  test("a deflated directory with a checksum other than 0 is refused", async () => {
    const error = await refuseZip([rawDir(emptyStream, { crc: 0x1234 })])
    expect(error.reason).toContain("checksum")
  })

  test("a deflated directory whose stream is cut short is refused", async () => {
    const error = await refuseZip([rawDir(emptyStream.subarray(0, 1))])
    expect(error.reason).toStartWith("damaged (")
  })
})

describe("the width of a data descriptor", () => {
  const empty = (signature: boolean, wide: boolean, zip64 = true): ZipEntry => ({
    name: "empty.txt",
    data: "",
    method: "stored",
    zip64,
    descriptor: { signature, wide },
    local: zip64 ? { extra: zip64LocalExtra(0, 0) } : undefined,
  })
  const next: ZipEntry = { name: "next.txt", data }

  test.each([
    ["signed", true],
    ["unsigned", false],
  ])("a zip64 empty stored entry takes a %s 64-bit descriptor", async (_label, signature) => {
    const listing = await inspectZip([empty(signature, true), next], { zip64: true })
    expect(listing.entries.map((entry) => entry.name)).toEqual(["empty.txt", "next.txt"])
  })

  test.each([
    ["signed", true],
    ["unsigned", false],
  ])("a zip64 entry with a %s 32-bit descriptor is refused", async (_label, signature) => {
    const error = await refuseZip([empty(signature, false), next], { zip64: true })
    expect(error.message).toContain("data descriptor of empty.txt")
  })

  test.each([
    ["signed", true],
    ["unsigned", false],
  ])("an entry that is not zip64 takes a %s 32-bit descriptor and no other", async (_label, signature) => {
    expect((await inspectZip([empty(signature, false, false), next])).files).toBe(2)
    // The 32-bit reading ends before the 64-bit one does, and the bytes left over are not accounted for
    const error = await refuseZip([empty(signature, true, false), next])
    expect(error.message).toMatch(/data descriptor of empty.txt|does not account for/)
  })

  test("a descriptor of the wrong width is refused whatever the entry holds", async () => {
    const wrong = await refuseZip([{ name: "a.txt", data, zip64: true, descriptor: { wide: false } }])
    expect(wrong.message).toContain("data descriptor of a.txt")
  })

  test("a zip64 entry is one that carries a zip64 extra field, or a saturated field", async () => {
    const extraOnly: ZipEntry = { ...empty(true, true), zip64: undefined, extra: zip64Extra() }
    expect((await inspectZip([extraOnly, next])).files).toBe(2)
  })

  function zip64Extra(): Buffer {
    return Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00])])
  }
})

describe("a streaming writer's zip64 entry: marked in the local header only", () => {
  const SATURATED = 0xffffffff
  let streams = 0
  // The central record has ordinary sizes and no zip64 extra field, as Python's zipfile writes it with force_zip64
  const streamed = (signature: boolean, wide: boolean, body = data, marking: "both" | "extra" | "sizes" = "both") =>
    ({
      name: `streamed${++streams}.txt`,
      data: body,
      descriptor: { signature, wide },
      local: {
        extra: marking === "sizes" ? undefined : zip64LocalExtra(0, 0),
        ...(marking === "extra" ? {} : { size: SATURATED, compressedSize: SATURATED }),
      },
    }) satisfies ZipEntry
  const next: ZipEntry = { name: "next.txt", data }

  test.each([
    ["signed", true],
    ["unsigned", false],
  ])("takes a %s 64-bit descriptor", async (_label, signature) => {
    const listing = await inspectZip([streamed(signature, true), streamed(signature, true, "")], { zip64: false })
    expect(listing.entries.map((entry) => entry.size)).toEqual([data.length, 0])
    expect((await inspectZip([streamed(signature, true), next])).files).toBe(2)
  })

  test.each([
    ["signed", true],
    ["unsigned", false],
  ])("is refused with a %s 32-bit descriptor", async (_label, signature) => {
    const error = await refuseZip([streamed(signature, false), next])
    expect(error.message).toMatch(/data descriptor of streamed\d+.txt|does not account for/)
    const empty = await refuseZip([streamed(signature, false, ""), next])
    expect(empty.message).toMatch(/data descriptor of streamed\d+.txt|does not account for/)
  })

  test("is marked by a zip64 extra field alone, or by saturated sizes alone", async () => {
    expect((await inspectZip([streamed(true, true, data, "extra"), next])).files).toBe(2)
    expect((await refuseZip([streamed(true, false, data, "extra"), next])).message).toContain("data descriptor")
  })

  test("is not marked by saturated sizes without a zip64 field to hold them", async () => {
    const error = await refuseZip([streamed(true, true, data, "sizes"), next])
    expect(error.message).toContain("disagree")
  })

  test("an ordinary entry in the same archive keeps its 32-bit descriptor", async () => {
    const plain: ZipEntry = { name: "plain.txt", data, descriptor: { wide: false } }
    expect((await inspectZip([streamed(true, true), plain, streamed(false, true)])).files).toBe(3)
  })
})

describe("general-purpose flags that must agree", () => {
  test.each([
    ["the UTF-8 name flag", { name: "日本語.txt", local: { flags: 0 } }],
    ["an unused flag", { name: "a.txt", local: { flags: 0x0010 } }],
    ["the data descriptor flag", { name: "a.txt", local: { flags: 0x0008 } }],
  ])("%s differing is refused", async (_label, entry) => {
    const error = await refuseZip([{ data, ...entry }])
    expect(error.message).toContain("disagree")
  })

  test.each([
    ["encryption (bit 0)", 0x0001],
    ["strong encryption (bit 6)", 0x0040],
    ["masked headers (bit 13)", 0x2000],
  ])("%s in the local header alone is refused as encrypted", async (_label, flags) => {
    const error = await refuseZip([{ name: "a.txt", data, local: { flags } }])
    expect(error.reason).toBe("encrypted")
  })

  test("the deflate option bits (1 and 2) may differ, since they only hint at how hard deflate worked", async () => {
    expect((await inspectZip([{ name: "a.txt", data, local: { flags: 0x0002 } }])).files).toBe(1)
    expect((await inspectZip([{ name: "a.txt", data, flags: 0x0004, local: { flags: 0x0000 } }])).files).toBe(1)
  })
})

describe("extra fields", () => {
  const timestamp = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0, 0, 0, 0])
  const field = (id: number, ...body: number[]) => Buffer.from([id & 0xff, id >> 8, body.length, 0, ...body])

  test("the same id twice in a central record is refused", async () => {
    const error = await refuseZip([{ name: "a.txt", data, extra: Buffer.concat([timestamp, timestamp]) }])
    expect(error.message).toContain("appears twice")
  })

  test("the zip64 id twice is refused, with the real one first or last", async () => {
    const decoy = field(1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9)
    expect((await refuseZip([{ name: "a.txt", data, zip64: true, extra: decoy }])).message).toContain("appears twice")
  })

  test("the same id twice in a local header is refused", async () => {
    const extra = Buffer.concat([timestamp, timestamp])
    expect((await refuseZip([{ name: "a.txt", data, local: { extra } }])).message).toContain("appears twice")
  })

  test("different ids side by side are fine", async () => {
    const extra = Buffer.concat([timestamp, field(0x7855, 1, 2)])
    expect((await inspectZip([{ name: "a.txt", data, extra, local: { extra } }])).files).toBe(1)
  })

  test("a field whose length runs past the block is refused, in either header", async () => {
    const overrun = Buffer.from([0x55, 0x54, 0x40, 0x00, 1, 2])
    expect((await refuseZip([{ name: "a.txt", data, extra: overrun }])).message).toContain("cut short")
    expect((await refuseZip([{ name: "a.txt", data, local: { extra: overrun } }])).message).toContain("cut short")
    expect((await refuseZip([{ name: "a.txt", data, extra: Buffer.from([0x55, 0x54, 0x01]) }])).message).toContain(
      "cut short",
    )
  })
})

describe("the end records", () => {
  const entries: ZipEntry[] = [
    { name: "a.txt", data },
    { name: "b.txt", data, zip64: true },
  ]

  test("a zip64 end record is accepted with saturated classic fields, or with the same real values", async () => {
    expect((await inspectZip(entries, { zip64: true })).files).toBe(2)
    expect((await inspectZip(entries, { zip64: true, classic: "real" })).files).toBe(2)
  })

  const saturated = { entries: 0xffff, size: 0xffffffff, offset: 0xffffffff }

  test.each([
    ["entries", { entries: 5 }],
    ["size", { size: 99 }],
    ["offset", { offset: 3 }],
  ])("a classic %s that is not saturated and not the zip64 value is refused", async (_label, wrong) => {
    const error = await refuseZip(entries, { zip64: true, classic: { ...saturated, ...wrong } })
    expect(error.message).toContain("zip64 end record disagrees with the classic one")
  })

  test("a comment holding the signature of another end record is refused", async () => {
    const error = await refuseZip(entries, { comment: `a comment with ${String.fromCharCode(0x50, 0x4b, 5, 6)} in it` })
    expect(error.message).toContain("ambiguous")
  })

  test("a whole end record hidden at the end of the real one's comment is refused", async () => {
    const fake = String.fromCharCode(0x50, 0x4b, 5, 6) + "\0".repeat(18)
    const error = await refuseZip(entries, { comment: fake })
    expect(error.message).toContain("ambiguous")
  })

  test("an end record whose comment stops short of the end of the file is refused", async () => {
    const zip = buildZip(entries, { comment: "twelve bytes" })
    zip.writeUInt16LE(5, zip.length - 12 - 2)
    expect((await refusal(() => inspectArchive(fixtures.write("short.zip", zip), "zip"))).message).toContain("damaged")
  })

  test("an ordinary comment is fine", async () => {
    expect((await inspectZip(entries, { comment: "made by a test, PK is not enough" })).files).toBe(2)
  })
})
