import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createSandbox, outgoingRefusal, type Sandbox } from "./outgoing.testing"
import { buildZip } from "../archive/zip.testing"
import { ELF_BYTES, MACHO_BYTES, PE_BYTES } from "../archive/archive.testing"
import { checkOutgoingFile } from "./check"

let box: Sandbox
beforeEach(() => {
  box = createSandbox()
})
afterEach(() => box.remove())

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)])

const check = (path: string, name: string, options?: Parameters<typeof checkOutgoingFile>[2]) =>
  checkOutgoingFile(path, { name }, options)

describe("checkOutgoingFile and a plain file", () => {
  test("passes text, and reports its size", async () => {
    const path = box.write("copy", "hello\nworld\n")
    expect(await check(path, "notes.txt")).toEqual({ kind: "file", size: 12, head: Buffer.from("hello\nworld\n") })
  })

  test("passes image bytes, and bytes that are not text under a name that does not claim to be a script", async () => {
    expect(await check(box.write("copy", PNG), "photo.png")).toEqual({
      kind: "file",
      size: PNG.length,
      head: Buffer.from(PNG),
    })
    expect((await check(box.write("copy2", Buffer.from([0, 1, 2, 3, 0, 255])), "data.bin")).kind).toBe("file")
  })

  test("refuses an empty file", async () => {
    const refusal = await outgoingRefusal(() => check(box.write("copy", ""), "notes.txt"))
    expect(refusal.reason).toBe("an empty file")
    expect(refusal.entry).toBeUndefined()
  })

  test.each([
    ["ELF", ELF_BYTES, "a program"],
    ["Mach-O", MACHO_BYTES, "a program"],
    ["PE", PE_BYTES, "a program"],
  ])("refuses %s bytes under an innocent name", async (_format, bytes, reason) => {
    expect((await outgoingRefusal(() => check(box.write("copy", bytes), "notes.txt"))).reason).toBe(reason)
  })

  test("refuses a program by its name whatever its bytes", async () => {
    const refusal = await outgoingRefusal(() => check(box.write("copy", "MZ not really\n"), "setup.exe"))
    expect(refusal.reason).toBe("a program")
  })

  test("refuses an archive format that cannot be inspected, and a mislabeled one", async () => {
    const rar = Buffer.concat([Buffer.from("Rar!\x1a\x07\x00"), Buffer.alloc(64)])
    expect((await outgoingRefusal(() => check(box.write("copy", rar), "docs.dat"))).reason).toContain(
      "cannot be inspected",
    )
    const mislabeled = await outgoingRefusal(() => check(box.write("copy2", "plain text\n"), "docs.zip"))
    expect(mislabeled.reason).toContain("mislabeled")
  })

  test("refuses a path that is not a regular file, and never follows a link", async () => {
    const folder = box.mkdir("a-folder")
    expect((await outgoingRefusal(() => check(folder, "notes.txt"))).reason).toBe("not a regular file")
    const target = box.write("target.txt")
    const link = box.link("copy-link", target)
    await expect(check(link, "notes.txt")).rejects.toThrow()
  })

  test("a document built on zip is a file: only its outer bytes are read, never its parts", async () => {
    const docx = buildZip([
      { name: "word/document.xml", data: "<w:document/>" },
      { name: ".env", data: "TOKEN=made-up\n" },
    ])
    expect(await check(box.write("copy.docx", docx), "report.docx")).toMatchObject({ kind: "file", size: docx.length })
  })

  test("stops at once for an abort signal", async () => {
    const path = box.write("copy", "hello\n")
    const controller = new AbortController()
    controller.abort()
    await expect(check(path, "notes.txt", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
  })
})
