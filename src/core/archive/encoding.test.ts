import { describe, expect, test } from "bun:test"
import { decodeCp437, decodeUtf8, decodeUtf8Lossy } from "./encoding"

describe("decodeCp437", () => {
  test("maps ASCII to itself and every byte from 0x80 to a distinct character", () => {
    expect(decodeCp437(Buffer.from("plain/name.txt"))).toBe("plain/name.txt")
    const high = decodeCp437(Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i))
    expect(Array.from(high)).toHaveLength(128)
    expect(new Set(high).size).toBe(128)
  })

  test("decodes the characters zip tools write", () => {
    expect(decodeCp437(Buffer.from([0x82, 0x81, 0x84, 0xe1, 0xf8, 0xdb]))).toBe("éüäß°█")
  })
})

describe("decodeUtf8", () => {
  test("returns undefined for bytes that are not UTF-8", () => {
    expect(decodeUtf8(Buffer.from([0x61, 0xff]))).toBeUndefined()
    expect(decodeUtf8(Buffer.from("日本語"))).toBe("日本語")
  })

  test("keeps a leading byte order mark, so the checks and the listing see it", () => {
    expect(decodeUtf8(Buffer.from("\uFEFFname"))).toBe("\uFEFFname")
    expect(decodeUtf8Lossy(Buffer.from("\uFEFFname"))).toBe("\uFEFFname")
  })

  test("decodes lossily with the replacement character", () => {
    expect(decodeUtf8Lossy(Buffer.from([0x61, 0xff, 0x62]))).toBe("a\uFFFDb")
  })
})
