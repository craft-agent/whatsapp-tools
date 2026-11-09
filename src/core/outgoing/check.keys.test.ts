import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { CHUNK_SIZE } from "../archive/streams"
import { checkOutgoingFile } from "./check"
import { PRIVATE_KEY_REASON, scanData } from "./content-scan"
import {
  createSandbox,
  fakeKey,
  fakePuttyKey,
  fakeSsh2Key,
  outgoingRefusal,
  pieces,
  utf16,
  utf32,
  type Sandbox,
} from "./outgoing.testing"

let box: Sandbox
beforeEach(() => {
  box = createSandbox()
})
afterEach(() => box.remove())

const refuses = async (bytes: string | Buffer, name = "notes.txt") => {
  const refusal = await outgoingRefusal(() => checkOutgoingFile(box.write("copy", bytes), { name }))
  return refusal.reason === PRIVATE_KEY_REASON
}

describe("private key formats", () => {
  test.each([
    ["PRIVATE KEY", fakeKey()],
    ["RSA PRIVATE KEY", fakeKey("RSA ")],
    ["EC PRIVATE KEY", fakeKey("EC ")],
    ["DSA PRIVATE KEY", fakeKey("DSA ")],
    ["ENCRYPTED PRIVATE KEY", fakeKey("ENCRYPTED ")],
    ["OPENSSH PRIVATE KEY", fakeKey("OPENSSH ")],
    ["PGP PRIVATE KEY BLOCK", fakeKey("PGP ", " BLOCK")],
    ["a label with a hyphen, an underscore and lower case", fakeKey("Made_up-key ")],
    ["an ssh.com key", fakeSsh2Key(false)],
    ["an encrypted ssh.com key", fakeSsh2Key(true)],
    ["a PuTTY version 2 key", fakePuttyKey(2)],
    ["a PuTTY version 3 key", fakePuttyKey(3)],
  ])("refuses %s", async (_format, key) => {
    expect(await refuses(`first line\n${key}last line\n`)).toBe(true)
    expect(await refuses(key)).toBe(true)
  })

  test("refuses a key written with CRLF line ends, alone or in the middle of a text", async () => {
    for (const key of [fakeKey("RSA "), fakeSsh2Key(true), fakePuttyKey(3)]) {
      const crlf = key.replace(/\n/g, "\r\n")
      expect(await refuses(crlf)).toBe(true)
      expect(await refuses(`first\r\nsecond\r\n${crlf}end\r\n`)).toBe(true)
    }
  })

  test("sends what only looks like a key", async () => {
    const dashes = "----"
    const text = [
      `${dashes}- BEGIN CERTIFICATE ${dashes}-`,
      `${dashes} BEGIN SSH2 PUBLIC KEY ${dashes}`,
      `${dashes} BEGIN SSH2 ENCRYPTED KEY ${dashes}`,
      "PuTTY-User-Key-File-: no version",
      "PuTTY-User-Key-File-x: not a version",
      "putty-user-key-file-2: lower case",
      "",
    ].join("\n")
    expect((await checkOutgoingFile(box.write("copy", text), { name: "notes.txt" })).kind).toBe("file")
  })

  test("finds each format cut by a chunk boundary, wherever it is cut", async () => {
    for (const key of [fakeKey("ENCRYPTED "), fakeSsh2Key(true), fakePuttyKey(3)]) {
      const first = key.split("\n")[0]!.length
      for (const before of [1, 2, Math.floor(first / 2), first - 1]) {
        const text = "x".repeat(CHUNK_SIZE - before) + key
        expect(await refuses(text, "big.txt")).toBe(true)
      }
    }
  })
})

describe("private keys in UTF-16", () => {
  const text = (key: string) => `notes\n${key}more notes\n`
  const keys = [fakeKey("RSA "), fakeSsh2Key(false), fakePuttyKey(2)]

  test.each([
    ["le", true],
    ["le", false],
    ["be", true],
    ["be", false],
  ] as const)("refuses a key in UTF-16 (%s, byte order mark: %p)", async (order, bom) => {
    for (const key of keys) {
      expect(await refuses(utf16(text(key), order, bom), "notes.txt")).toBe(true)
      expect(await refuses(utf16(text(key.replace(/\n/g, "\r\n")), order, bom), "notes.txt")).toBe(true)
    }
  })

  test("refuses a key in a long UTF-16 text", async () => {
    const lead = "a line of made-up text\n".repeat(1000)
    for (const [order, bom] of [
      ["le", false],
      ["be", false],
      ["le", true],
      ["be", true],
    ] as const) {
      expect(await refuses(utf16(lead + text(keys[0]!), order, bom))).toBe(true)
    }
  })

  test("refuses a key after more than 8 KB of other scripts, with or without a byte order mark", async () => {
    const japanese = "日本語のテキスト。".repeat(1000)
    for (const order of ["le", "be"] as const) {
      for (const bom of [true, false]) {
        const bytes = utf16(japanese + text(keys[0]!), order, bom)
        expect(Buffer.byteLength(japanese, "utf16le")).toBeGreaterThan(8192)
        expect(await refuses(bytes)).toBe(true)
        expect(await scanData("notes.txt", pieces(bytes, 4099))).toBe(PRIVATE_KEY_REASON)
      }
    }
  })

  test("refuses a key in UTF-32, either order, with or without a byte order mark", async () => {
    for (const order of ["le", "be"] as const) {
      for (const bom of [true, false]) {
        const bytes = utf32(`${"x".repeat(3000)}${text(keys[0]!)}`, order, bom)
        expect(await refuses(bytes)).toBe(true)
        expect(await scanData("notes.txt", pieces(bytes, 1001))).toBe(PRIVATE_KEY_REASON)
      }
    }
  })

  test("refuses a key whose first byte ends one chunk and whose first NUL starts the next", async () => {
    for (const order of ["le", "be"] as const) {
      const bytes = Buffer.concat([Buffer.from("x".repeat(CHUNK_SIZE - 1)), utf16(keys[0]!, order, false)])
      expect(await scanData("notes.txt", pieces(bytes, CHUNK_SIZE))).toBe(PRIVATE_KEY_REASON)
      const wide = Buffer.concat([Buffer.from("x".repeat(CHUNK_SIZE - 3)), utf32(keys[1]!, order, false)])
      expect(await scanData("notes.txt", pieces(wide, CHUNK_SIZE))).toBe(PRIVATE_KEY_REASON)
    }
  })

  test("finds a key that holds other bytes between its characters only if they are NULs", async () => {
    const spaced = Buffer.from([...keys[0]!].flatMap((character) => [character.charCodeAt(0), 1]))
    expect(await scanData("notes.txt", pieces(spaced, 4096))).toBeUndefined()
  })

  test("reads a binary file with many NULs twice at most, and finds nothing in what only looks like a marker", async () => {
    const near = utf16("-----BEGIN CERTIFICATE-----\n", "le", false)
    const chunks = 40
    const bytes = Buffer.alloc(chunks * CHUNK_SIZE)
    for (let at = 0; at + near.length < bytes.length; at += 4099) near.copy(bytes, at)
    const test = spyOn(RegExp.prototype, "test")
    try {
      expect(await scanData("notes.txt", pieces(bytes, CHUNK_SIZE))).toBeUndefined()
      expect(test.mock.calls.length).toBe(2 * chunks)
    } finally {
      test.mockRestore()
    }
  })

  test("reads a file with no NUL once", async () => {
    const bytes = Buffer.from("plain text\n".repeat(20000))
    const test = spyOn(RegExp.prototype, "test")
    try {
      expect(await scanData("notes.txt", pieces(bytes, CHUNK_SIZE))).toBeUndefined()
      expect(test.mock.calls.length).toBe(Math.ceil(bytes.length / CHUNK_SIZE))
    } finally {
      test.mockRestore()
    }
  })

  test("finds a key cut by a chunk boundary of the file", async () => {
    const header = keys[0]!.split("\n")[0]!.length
    for (const order of ["le", "be"] as const) {
      for (const before of [1, 2, 20, header - 1]) {
        const lead = "x".repeat(CHUNK_SIZE / 2 - before)
        expect(await refuses(utf16(lead + keys[0]!, order, true))).toBe(true)
        expect(await refuses(utf16(lead + keys[0]!, order, false))).toBe(true)
      }
    }
  })

  test("finds a key however the data is cut into pieces, an odd byte at the end of a piece included", async () => {
    for (const order of ["le", "be"] as const) {
      for (const bom of [true, false]) {
        const bytes = utf16(`${"ab".repeat(2200)}${keys[0]!}`, order, bom)
        for (const size of [1, 3, 7, 4095, 4097, 5001]) {
          expect(await scanData("notes.txt", pieces(bytes, size))).toBe(PRIVATE_KEY_REASON)
        }
      }
    }
  })

  test("a UTF-16 text without a key passes, and so does a key-free file of the same shape", async () => {
    for (const bytes of [
      utf16("just notes\n".repeat(900), "le", true),
      utf16("just notes\n".repeat(900), "be", false),
    ]) {
      for (const size of [3, 5000, CHUNK_SIZE]) {
        expect(await scanData("notes.txt", pieces(bytes, size))).toBeUndefined()
      }
    }
  })

  test("a key in UTF-16 is found in a short file", async () => {
    const bytes = utf16(keys[1]!, "le", false)
    expect(bytes.length).toBeLessThan(4096)
    expect(await scanData("notes.txt", pieces(bytes, 11))).toBe(PRIVATE_KEY_REASON)
  })
})
