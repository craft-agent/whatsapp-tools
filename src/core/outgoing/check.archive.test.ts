import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { ELF_BYTES } from "../archive/archive.testing"
import { DEFAULT_LIMITS } from "../archive/limits"
import { CHUNK_SIZE } from "../archive/streams"
import { buildTar } from "../archive/tar.testing"
import { buildZip } from "../archive/zip.testing"
import { checkOutgoingFile } from "./check"
import { BINARY_SCRIPT_REASON, PRIVATE_KEY_REASON } from "./content-scan"
import { checkEntries } from "./entries"
import { createSandbox, fakeKey, outgoingRefusal, utf16, type Sandbox } from "./outgoing.testing"

let box: Sandbox
beforeEach(() => {
  box = createSandbox()
})
afterEach(() => box.remove())

/** One file of an archive to build. */
type Member = { name: string; data?: string | Buffer; dir?: boolean; stored?: boolean }

const FORMATS = [
  [
    "zip",
    "bundle.zip",
    (members: Member[]) => buildZip(members.map((m) => ({ ...m, method: m.stored ? "stored" : undefined }))),
  ],
  ["tar", "bundle.tar", (members: Member[]) => buildTar(members.map((m) => (m.dir ? { name: m.name, type: "5" } : m)))],
  [
    "tgz",
    "bundle.tgz",
    (members: Member[]) => gzipSync(buildTar(members.map((m) => (m.dir ? { name: m.name, type: "5" } : m)))),
  ],
] as const

const check = (path: string, name: string, options?: Parameters<typeof checkOutgoingFile>[2]) =>
  checkOutgoingFile(path, { name }, options)

describe.each(FORMATS)("checkOutgoingFile and a %s archive", (format, name, build) => {
  const refusalOf = (members: Member[]) =>
    outgoingRefusal(() => check(box.write(`copy.${format}`, build(members)), name))

  test("passes an archive whose entries pass, with its listing and size", async () => {
    const bytes = build([
      { name: "docs/", dir: true },
      { name: "docs/readme.txt", data: "hello\n" },
      { name: "run.sh", data: "#!/bin/sh\necho hi\n" },
    ])
    const result = await check(box.write(`copy.${format}`, bytes), name)
    expect(result).toMatchObject({ kind: "archive", format: format === "tgz" ? "tgz" : format, size: bytes.length })
    if (result.kind !== "archive") throw new Error("expected an archive")
    expect(result.listing.files).toBe(2)
    expect(result.listing.entries.map((entry) => entry.name)).toEqual(["docs/", "docs/readme.txt", "run.sh"])
  })

  test.each([
    [".env", ".env"],
    ["config/.ENV.local", "config/.ENV.local"],
    ["keys/server.pem", "keys/server.pem"],
    ["notes/my-secret.txt", "notes/my-secret.txt"],
  ])("refuses a file entry named %s, naming the entry", async (path, entry) => {
    const refusal = await refusalOf([
      { name: "ok.txt", data: "fine\n" },
      { name: path, data: "TOKEN=made-up\n" },
    ])
    expect(refusal.reason).toBe("named like a key or a secret")
    expect(refusal.entry).toBe(entry)
    expect(refusal.message).toBe(`the entry ${entry} is named like a key or a secret`)
  })

  test.each([[".ssh/"], ["home/.GNUPG/"], ["a/.git/"]])("refuses a folder entry %s", async (path) => {
    const refusal = await refusalOf([
      { name: "ok.txt", data: "fine\n" },
      { name: path, dir: true },
    ])
    expect(refusal.reason).toContain("inside a key or settings folder")
    expect(refusal.entry).toBe(path)
  })

  test("refuses a file below a key or settings folder, even when no entry made the folder", async () => {
    const refusal = await refusalOf([{ name: "x/.aws/config.txt", data: "region = nowhere\n" }])
    expect(refusal.reason).toBe("inside a key or settings folder (.aws)")
    expect(refusal.entry).toBe("x/.aws/config.txt")
  })

  test.each([
    [[]],
    [[{ name: "empty/", dir: true }]],
    [
      [
        { name: "empty/", dir: true },
        { name: "also/", dir: true },
      ],
    ],
  ])("refuses an archive with no files", async (members) => {
    const refusal = await refusalOf(members as Member[])
    expect(refusal.reason).toBe("an archive with no files")
    expect(refusal.entry).toBeUndefined()
  })

  test("refuses a private key in UTF-16 inside an entry, naming the entry", async () => {
    const refusal = await refusalOf([{ name: "docs/notes.txt", data: utf16(`text\n${fakeKey("RSA ")}`, "le", true) }])
    expect(refusal.reason).toBe(PRIVATE_KEY_REASON)
    expect(refusal.entry).toBe("docs/notes.txt")
  })

  test("refuses a private key inside an entry, naming the entry", async () => {
    const refusal = await refusalOf([
      { name: "a.txt", data: "fine\n" },
      { name: "deep/notes.txt", data: `text\n${fakeKey("RSA ")}` },
    ])
    expect(refusal.reason).toBe(PRIVATE_KEY_REASON)
    expect(refusal.entry).toBe("deep/notes.txt")
  })

  test("finds a key that a chunk boundary cuts inside an entry", async () => {
    const header = fakeKey("OPENSSH ")
    for (const before of [1, 17, header.indexOf("\n") - 1]) {
      const data = Buffer.from("x".repeat(CHUNK_SIZE - before) + header)
      const refusal = await refusalOf([{ name: "big.txt", data, stored: true }])
      expect(refusal.reason).toBe(PRIVATE_KEY_REASON)
      expect(refusal.entry).toBe("big.txt")
    }
  })

  test("sends a script entry whose bytes are text, and refuses one whose bytes are not", async () => {
    expect(
      (await check(box.write(`ok.${format}`, build([{ name: "bin/run.py", data: "print(1)\n" }])), name)).kind,
    ).toBe("archive")
    const refusal = await refusalOf([{ name: "bin/run.py", data: Buffer.from([0x70, 0, 0x72, 0xff, 0]) }])
    expect(refusal.reason).toBe(BINARY_SCRIPT_REASON)
    expect(refusal.entry).toBe("bin/run.py")
  })

  test("refuses a program or an archive inside it, as inspection does", async () => {
    const program = await refusalOf([{ name: "tool/readme.txt", data: ELF_BYTES }])
    expect(program.reason).toBe("a program")
    expect(program.entry).toBe("tool/readme.txt")
    const inner = await refusalOf([{ name: "inner.zip", data: buildZip([{ name: "a.txt", data: "x" }]) }])
    expect(inner.reason).toContain("an archive inside the archive")
    expect(inner.entry).toBe("inner.zip")
  })

  test("refuses an entry named the Windows way, which inspection already refuses for its backslashes", async () => {
    const refusal = await refusalOf([{ name: "project\\.ssh\\id_rsa", data: "x\n" }])
    expect(refusal.reason).toContain("backslash")
    expect(refusal.entry).toBe("project\\.ssh\\id_rsa")
  })

  test("checks the names of entries split at both separators, should inspection ever let one through", async () => {
    const path = box.write(`windows.${format}`, build([{ name: "project\\.ssh\\id_rsa", data: "x\n" }]))
    const refusal = await outgoingRefusal(() => checkEntries(path, format))
    expect(refusal.reason).toBe("inside a key or settings folder (.ssh)")
    const named = box.write(`named.${format}`, build([{ name: "project\\app\\.env", data: "x\n" }]))
    expect((await outgoingRefusal(() => checkEntries(named, format))).reason).toBe("named like a key or a secret")
  })

  test("names an entry by its cleaned name", async () => {
    const refusal = await refusalOf([{ name: "a\u202Eb/.env", data: "x\n" }])
    expect(refusal.entry).toBe("a?b/.env")
    expect(refusal.message).not.toContain("\u202E")
  })

  test("keeps the limits it is given", async () => {
    const members = [
      { name: "a.txt", data: "a" },
      { name: "b.txt", data: "b" },
    ]
    const path = box.write(`copy.${format}`, build(members))
    const refusal = await outgoingRefusal(() => check(path, name, { limits: { ...DEFAULT_LIMITS, maxEntries: 1 } }))
    expect(refusal.entry).toBeUndefined()
    expect(refusal.reason).toContain("entries")
  })

  test("stops at once for an abort signal", async () => {
    const path = box.write(`copy.${format}`, build([{ name: "a.txt", data: "a" }]))
    const controller = new AbortController()
    controller.abort()
    await expect(check(path, name, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  })
})
