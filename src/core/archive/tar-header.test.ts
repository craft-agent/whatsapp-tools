import { describe, expect, test } from "bun:test"
import { checksumMatches, looksLikeTarHeader, parseHeader, parsePaxRecords } from "./tar-header"
import { base256, paxData, tarHeader } from "./tar.testing"

describe("tar headers", () => {
  test("a header written by the helper has a matching checksum, and one changed byte breaks it", () => {
    const header = tarHeader({ name: "a.txt", data: "abc" })
    expect(checksumMatches(header)).toBe(true)
    header[0] ^= 1
    expect(checksumMatches(header)).toBe(false)
  })

  test("accepts a checksum computed over signed bytes, as some old tars write it", () => {
    const header = tarHeader({ name: "caf\u00e9", data: "" })
    let signed = 0
    for (let i = 0; i < 512; i++) {
      const byte = i >= 148 && i < 156 ? 0x20 : header[i]!
      signed += byte > 127 ? byte - 256 : byte
    }
    header.write(`${signed.toString(8).padStart(6, "0")}\0 `, 148, "latin1")
    expect(checksumMatches(header)).toBe(true)
  })

  test("reads an octal size and a base-256 size", () => {
    expect(parseHeader(tarHeader({ name: "a", data: "abcdef" })).size).toBe(6)
    expect(parseHeader(tarHeader({ name: "a", size: base256(123_456_789_012) })).size).toBe(123_456_789_012)
  })

  test("gives no size for a negative or oversized base-256 number or for junk", () => {
    expect(
      parseHeader(tarHeader({ name: "a", size: Buffer.from("ffffffffffffffffffffffff", "hex") })).size,
    ).toBeUndefined()
    expect(
      parseHeader(tarHeader({ name: "a", size: Buffer.from("80ffffffffffffffffffffff", "hex") })).size,
    ).toBeUndefined()
    expect(parseHeader(tarHeader({ name: "a", size: Buffer.from("12x45\0\0\0\0\0\0\0") })).size).toBeUndefined()
    expect(parseHeader(tarHeader({ name: "a", size: Buffer.alloc(12) })).size).toBeUndefined()
  })

  test("joins the prefix only for POSIX ustar headers", () => {
    const path = (magic: "ustar" | "gnu" | "v7") =>
      Buffer.from(parseHeader(tarHeader({ name: "f", prefix: "p", magic })).path).toString()
    expect(path("ustar")).toBe("p/f")
    expect(path("gnu")).toBe("f")
    expect(path("v7")).toBe("f")
  })

  test("only a whole header block with a good checksum looks like a tar", () => {
    const header = tarHeader({ name: "a.txt", data: "abc" })
    expect(looksLikeTarHeader(header)).toBe(true)
    expect(looksLikeTarHeader(header.subarray(0, 511))).toBe(false)
    expect(looksLikeTarHeader(Buffer.alloc(512))).toBe(false)
    expect(looksLikeTarHeader(Buffer.alloc(512, 0x61))).toBe(false)
  })
})

describe("pax records", () => {
  test("reads each record's key and value", () => {
    const records = parsePaxRecords(paxData({ path: "a/日本.txt", size: "12" }))
    expect(records?.map(({ key, value }) => [key, Buffer.from(value).toString()])).toEqual([
      ["path", "a/日本.txt"],
      ["size", "12"],
    ])
  })

  test("keeps a value that holds = and newlines", () => {
    const records = parsePaxRecords(paxData({ comment: "a=b\nc" }))
    expect(Buffer.from(records![0]!.value).toString()).toBe("a=b\nc")
  })

  test.each([
    ["a length that is not a number", "x path=a\n"],
    ["a length longer than the data", "99 path=a\n"],
    ["a length too short to hold its record", "3 path=a\n"],
    ["no newline at the end", "11 path=abc"],
    ["no key", "6 =abc\n"],
    ["no =", "9 pathabc\n"],
    ["a length of zero", "0 path=a\n"],
  ])("rejects %s", (_label, text) => {
    expect(parsePaxRecords(Buffer.from(text))).toBeUndefined()
  })

  test("reads no records from nothing", () => {
    expect(parsePaxRecords(new Uint8Array(0))).toEqual([])
  })
})
