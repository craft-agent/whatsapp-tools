import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CLASSIFY_HEAD_BYTES } from "../archive/kind"
import { CHUNK_SIZE } from "../archive/streams"
import { BINARY_SCRIPT_REASON, PRIVATE_KEY_REASON } from "./content-scan"
import { checkOutgoingFile } from "./check"
import { createSandbox, fakeKey, outgoingRefusal, type Sandbox } from "./outgoing.testing"

let box: Sandbox
beforeEach(() => {
  box = createSandbox()
})
afterEach(() => box.remove())

const check = (path: string, name: string) => checkOutgoingFile(path, { name })

describe("checkOutgoingFile and scripts", () => {
  test("sends a script whose bytes are text", async () => {
    const script = "#!/bin/sh\necho 'héllo 日本語'\n"
    expect((await check(box.write("copy", script), "run.sh")).kind).toBe("file")
    expect((await check(box.write("copy2", script), "RUN.SH.")).kind).toBe("file")
    for (const name of ["a.py", "a.rb", "a.js", "a.tsx", "a.ps1", "a.bat", "a.php", "a.lua", "a.zsh"]) {
      expect((await check(box.write("copy3", "print(1)\n"), name)).kind).toBe("file")
    }
  })

  test("does not take .ts for a script: it is as often an MPEG transport stream", async () => {
    const stream = Buffer.from([0x47, 0x40, 0x00, 0x10, 0x00, 0x00, 0xb0, 0x0d])
    for (const name of ["clip.ts", "clip.mts", "clip.cts"]) {
      expect((await check(box.write("copy", stream), name)).kind).toBe("file")
    }
  })

  test("allows a byte order mark, and a character cut by the end of the head", async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("echo hi\n")])
    expect((await check(box.write("copy", withBom), "run.ps1")).kind).toBe("file")
    const cutAtHead = Buffer.from("a".repeat(CLASSIFY_HEAD_BYTES - 1) + "é" + "b".repeat(3000))
    expect(cutAtHead[CLASSIFY_HEAD_BYTES - 1]).toBe(0xc3)
    expect((await check(box.write("copy2", cutAtHead), "big.py")).kind).toBe("file")
  })

  test.each([
    ["a NUL", Buffer.from("echo hi\0\n")],
    ["invalid UTF-8", Buffer.from([0x65, 0x63, 0x68, 0x6f, 0xff, 0xfe, 0x0a])],
    ["a character cut by the end of the file", Buffer.from([0x65, 0x63, 0x68, 0x6f, 0xc3])],
    ["a UTF-16 text", Buffer.from("\ufeffecho hi\n", "utf16le")],
  ])("refuses a script with %s", async (_what, bytes) => {
    const refusal = await outgoingRefusal(() => check(box.write("copy", bytes), "run.sh"))
    expect(refusal.reason).toBe(BINARY_SCRIPT_REASON)
  })

  test("judges only the first bytes as text: a NUL after the head does not refuse a script", async () => {
    const longScript = Buffer.concat([Buffer.from("echo hi\n".repeat(1000)), Buffer.from([0, 1, 2]), Buffer.from("\n")])
    expect(longScript.length).toBeGreaterThan(CLASSIFY_HEAD_BYTES)
    expect((await check(box.write("copy", longScript), "long.sh")).kind).toBe("file")
  })

  test("refuses a script that is really a zip, as bytes that are not text", async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])
    const refusal = await outgoingRefusal(() => check(box.write("copy", zip), "install.js"))
    expect(refusal.reason).toBe(BINARY_SCRIPT_REASON)
  })
})

describe("checkOutgoingFile and private keys", () => {
  test.each([
    ["", ""],
    ["RSA ", ""],
    ["EC ", ""],
    ["ENCRYPTED ", ""],
    ["OPENSSH ", ""],
    ["PGP ", " BLOCK"],
  ])("refuses a %sPRIVATE KEY%s block in the middle of a text", async (label, suffix) => {
    const text = `before\nbefore\n${fakeKey(label, suffix)}after\n`
    const refusal = await outgoingRefusal(() => check(box.write("copy", text), "notes.txt"))
    expect(refusal.reason).toBe(PRIVATE_KEY_REASON)
    expect(refusal.entry).toBeUndefined()
  })

  test("finds a block whose first line is cut by a chunk boundary, wherever it is cut", async () => {
    const header = fakeKey("OPENSSH ")
    for (const boundary of [CHUNK_SIZE, 2 * CHUNK_SIZE]) {
      for (const before of [1, 2, 11, 20, header.indexOf("\n") - 1]) {
        const text = "x".repeat(boundary - before) + header
        const refusal = await outgoingRefusal(() => check(box.write("copy", text), "big.txt"))
        expect(refusal.reason).toBe(PRIVATE_KEY_REASON)
      }
    }
  })

  test("finds a block after more than a chunk of other bytes, in bytes that are not text", async () => {
    const bytes = Buffer.concat([Buffer.alloc(3 * CHUNK_SIZE + 5, 0), Buffer.from(fakeKey())])
    expect((await outgoingRefusal(() => check(box.write("copy", bytes), "dump.bin"))).reason).toBe(PRIVATE_KEY_REASON)
  })

  test("sends what only looks like a key: a certificate, a public key, a marker cut short", async () => {
    const dashes = "-----"
    const text = [
      `${dashes}BEGIN CERTIFICATE${dashes}`,
      `${dashes}BEGIN PUBLIC KEY${dashes}`,
      `${dashes}BEGIN PRIVATE`,
      `BEGIN PRIVATE KEY${dashes}`,
      `${dashes}BEGIN ${"A".repeat(60)} PRIVATE KEY${dashes}`,
      "",
    ].join("\n")
    expect((await check(box.write("copy", text), "notes.txt")).kind).toBe("file")
  })

  test("refuses a key inside a script text as a key", async () => {
    const refusal = await outgoingRefusal(() => check(box.write("copy", `#!/bin/sh\n# ${fakeKey()}`), "run.sh"))
    expect(refusal.reason).toBe(PRIVATE_KEY_REASON)
  })
})
