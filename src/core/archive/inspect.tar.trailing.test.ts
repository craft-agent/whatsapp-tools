import { afterAll, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { ELF_BYTES, createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import type { ArchiveFormat } from "./kind"
import { DEFAULT_LIMITS, type ArchiveLimits } from "./limits"
import { buildTar, longNameEntry, paxEntry, tarEntry, type TarEntry } from "./tar.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const NOTHING_AFTER = "the archive holds data after its end"
const good = () => buildTar([{ name: "a.txt", data: "hello" }])

const inspect = (bytes: Buffer, format: ArchiveFormat, limits?: ArchiveLimits) =>
  inspectArchive(fixtures.write(format === "tgz" ? "t.tgz" : "t.tar", bytes), format, limits)
const refuse = (bytes: Buffer, format: ArchiveFormat = "tar", limits?: ArchiveLimits) =>
  refusal(() => inspect(bytes, format, limits))

describe("data after the end of a tar", () => {
  test("a second tar after the terminator is refused, whatever it holds", async () => {
    const second = buildTar([{ name: "evil.sh", data: ELF_BYTES }])
    expect((await refuse(Buffer.concat([good(), second]))).reason).toBe(NOTHING_AFTER)
  })

  test("a single non-zero byte after the terminator is refused, however far in", async () => {
    const padding = Buffer.alloc(200_000)
    padding[199_999] = 1
    expect((await refuse(Buffer.concat([good(), padding]))).reason).toBe(NOTHING_AFTER)
  })

  test("zeros up to a record size, or beyond, are fine", async () => {
    const padded = Buffer.concat([good(), Buffer.alloc(10_240 - good().length)])
    expect(padded.length).toBe(10_240)
    expect((await inspect(padded, "tar")).files).toBe(1)
    expect((await inspect(Buffer.concat([good(), Buffer.alloc(300_000)]), "tar")).files).toBe(1)
  })

  test("zeros after the terminator count against the budget", async () => {
    const error = await refuse(Buffer.concat([good(), Buffer.alloc(100_000)]), "tar", {
      ...DEFAULT_LIMITS,
      maxMetadata: 50_000,
    })
    expect(error.reason).toBe("the archive's headers and padding take more than 50000 bytes")
  })
})

describe("data after the end of a gzipped tar", () => {
  test("a second gzip member that holds junk is refused", async () => {
    const bytes = Buffer.concat([gzipSync(good()), gzipSync(Buffer.from("junk, not zeros"))])
    expect((await refuse(bytes, "tgz")).reason).toBe(NOTHING_AFTER)
  })

  test("a second gzip member that holds another tar is refused", async () => {
    const bytes = Buffer.concat([gzipSync(good()), gzipSync(buildTar([{ name: "evil", data: ELF_BYTES }]))])
    expect((await refuse(bytes, "tgz")).reason).toBe(NOTHING_AFTER)
  })

  test("a second gzip member of zeros is padding", async () => {
    const bytes = Buffer.concat([gzipSync(good()), gzipSync(Buffer.alloc(10_240))])
    expect((await inspect(bytes, "tgz")).files).toBe(1)
  })

  test("zeros inside the first gzip member are padding", async () => {
    expect((await inspect(gzipSync(Buffer.concat([good(), Buffer.alloc(10_240)])), "tgz")).files).toBe(1)
  })

  test.each([
    ["checksum", -8],
    ["length", -4],
  ])("a corrupt %s in the trailer after a valid tar is refused", async (_label, at) => {
    const bytes = Buffer.from(gzipSync(good()))
    bytes[bytes.length + at] ^= 0xff
    expect((await refuse(bytes, "tgz")).message).toContain("damaged")
  })

  test("a trailer that is cut off after a valid tar is refused", async () => {
    const bytes = gzipSync(good())
    expect((await refuse(bytes.subarray(0, bytes.length - 3), "tgz")).message).toContain("damaged")
  })

  test("a second member with a corrupt trailer is refused", async () => {
    const second = Buffer.from(gzipSync(Buffer.alloc(1024)))
    second[second.length - 7] ^= 0xff
    expect((await refuse(Buffer.concat([gzipSync(good()), second]), "tgz")).message).toContain("damaged")
  })

  test("decompressed zeros after the tar are cut off at the limit", async () => {
    const bytes = Buffer.concat([gzipSync(good()), gzipSync(Buffer.alloc(4 * 1024 * 1024))])
    const error = await refuse(bytes, "tgz", { ...DEFAULT_LIMITS, maxMetadata: 100_000 })
    expect(error.reason).toBe("the archive's headers and padding take more than 100000 bytes")
  })
})

describe("the metadata of a tar", () => {
  const records = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`key${i}`, "v"]))

  test("a pax header with more records than the cap is refused, however small they are", async () => {
    const error = await refuse(buildTar([paxEntry(records(65)), { name: "a", data: "a" }]))
    expect(error.message).toContain("more than 64 records")
  })

  test("a pax header with thousands of tiny records is refused without reading them all", async () => {
    const error = await refuse(buildTar([paxEntry(records(3000)), { name: "a", data: "a" }]))
    expect(error.message).toContain("more than 64 records")
  })

  test("unknown keys are ignored, up to the cap, and the known ones still apply", async () => {
    const listing = await inspect(
      buildTar([paxEntry({ ...records(60), path: "named/by.pax" }), { name: "a", data: "a" }]),
      "tar",
    )
    expect(listing.entries).toEqual([{ name: "named/by.pax", size: 1 }])
  })

  test("a second pax header before an entry is refused", async () => {
    const error = await refuse(
      buildTar([paxEntry({ comment: "1" }), paxEntry({ comment: "2" }), { name: "a", data: "a" }]),
    )
    expect(error.reason).toBe("the archive has two extended headers for one entry")
  })

  test("a second long name before an entry is refused", async () => {
    const error = await refuse(buildTar([longNameEntry("one/"), longNameEntry("two/"), { name: "a", data: "a" }]))
    expect(error.reason).toBe("the archive has two long names for one entry")
  })

  test("a pax header or a long name for each entry is fine, and so are both for a few", async () => {
    const limits = { ...DEFAULT_LIMITS, maxEntries: 4 }
    const parts: Array<TarEntry | Buffer> = []
    for (let i = 0; i < 4; i++)
      parts.push(i % 2 ? paxEntry({ path: `p/${i}` }) : longNameEntry(`long/${i}`), { name: "x", data: "a" })
    expect((await inspect(buildTar(parts), "tar", limits)).files).toBe(4)
    const both = [paxEntry({ comment: "c" }), longNameEntry("long/one"), { name: "x", data: "a" }]
    expect((await inspect(buildTar(both), "tar", limits)).files).toBe(1)
  })

  test("every header counts toward a cap of twice the entry limit, global ones included", async () => {
    const limits = { ...DEFAULT_LIMITS, maxEntries: 3 }
    const globals = Array.from({ length: 7 }, () => paxEntry({ comment: "x" }, "g"))
    const error = await refuse(buildTar([...globals, { name: "a", data: "a" }]), "tar", limits)
    expect(error.message).toBe("the archive has more than 6 headers")
    expect((await inspect(buildTar([...globals.slice(0, 5), { name: "a", data: "a" }]), "tar", limits)).files).toBe(1)
  })

  test("the cap is 1000 headers at the default limit", async () => {
    const globals = Array.from({ length: 1001 }, () => paxEntry({ comment: "x" }, "g"))
    expect((await refuse(buildTar(globals))).message).toBe("the archive has more than 1000 headers")
  })

  test("headers, padding and extended data count against the byte budget", async () => {
    const globals = Array.from({ length: 3 }, () => paxEntry({ comment: "x" }, "g"))
    const error = await refuse(buildTar(globals), "tar", { ...DEFAULT_LIMITS, maxMetadata: 2000 })
    expect(error.reason).toBe("the archive's headers and padding take more than 2000 bytes")
  })

  test("an archive of empty files is held to the budget by its headers", async () => {
    const files = Array.from({ length: 10 }, (_, i) => tarEntry({ name: `f${i}` }))
    const tar = buildTar(files)
    expect((await inspect(tar, "tar", { ...DEFAULT_LIMITS, maxMetadata: tar.length })).files).toBe(10)
    expect((await refuse(tar, "tar", { ...DEFAULT_LIMITS, maxMetadata: tar.length - 1 })).reason).toContain("more than")
  })

  test("a gzipped stream of nothing but headers is cut off", async () => {
    const globals = Array.from({ length: 900 }, () => paxEntry({ comment: "x" }, "g"))
    const error = await refuse(gzipSync(buildTar(globals)), "tgz", { ...DEFAULT_LIMITS, maxMetadata: 100_000 })
    expect(error.reason).toBe("the archive's headers and padding take more than 100000 bytes")
  })
})
