import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { ELF_BYTES } from "./archive.testing"
import { classifyFile, type FileKind } from "./kind"
import { buildTar } from "./tar.testing"
import { buildZip } from "./zip.testing"

const FILE: FileKind = { kind: "file" }
const MACROS: FileKind = { kind: "refused", reason: "a document with macros" }
const zip = buildZip([{ name: "word/document.xml", data: "<w/>" }])
const text = Buffer.from("plain")

describe("documents that are zips inside", () => {
  test.each("docx xlsx pptx odt ods odp odg epub pages numbers key vsdx xps oxps".split(" "))(
    ".%s with zip bytes is a file, not an archive",
    (extension) => {
      expect(classifyFile({ name: `report.${extension}`, head: zip })).toEqual(FILE)
      expect(classifyFile({ name: `REPORT.${extension.toUpperCase()}`, type: "application/zip", head: zip })).toEqual(
        FILE,
      )
    },
  )

  test("an empty zip named as a document is a file", () => {
    expect(classifyFile({ name: "empty.docx", head: buildZip([]) })).toEqual(FILE)
  })

  test("other bytes under a document name or type follow the bytes, and the claim they break is refused", () => {
    const tar = buildTar([{ name: "a.txt", data: "a" }])
    const mislabeled: FileKind = {
      kind: "refused",
      reason: "mislabeled (its name or type says zip, its bytes do not)",
    }
    expect(classifyFile({ name: "report.docx", head: gzipSync(tar) })).toEqual(mislabeled)
    expect(classifyFile({ name: "report.epub", head: tar })).toEqual(mislabeled)
    expect(
      classifyFile({ type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", head: tar }),
    ).toEqual(mislabeled)
    expect(classifyFile({ name: "report.odt", head: text })).toEqual(mislabeled)
    expect(classifyFile({ name: "report.xlsx", head: new Uint8Array(0) })).toEqual(mislabeled)
  })

  test("a document name with a type that claims another archive is refused even over zip bytes", () => {
    expect(classifyFile({ name: "report.docx", type: "application/x-tar", head: zip }).kind).toBe("refused")
  })

  test("a program, an installer or an archive that cannot be inspected under a document name is refused by its bytes", () => {
    const sevenZip = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 0, 0])
    expect(classifyFile({ name: "report.docx", head: sevenZip })).toEqual({
      kind: "refused",
      reason: "an archive that cannot be inspected (7z)",
    })
  })

  test.each([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.text",
    "application/epub+zip",
    "application/vnd.ms-xpsdocument",
    "application/vnd.apple.pages",
    "Application/Vnd.Oasis.OpenDocument.Spreadsheet; charset=binary",
  ])("a declared type of %s makes a zip a file", (type) => {
    expect(classifyFile({ name: "download", type, head: zip })).toEqual(FILE)
    expect(classifyFile({ type, head: zip })).toEqual(FILE)
  })

  test("a program hidden as a document is still a program, by its bytes", () => {
    expect(classifyFile({ name: "report.docx", head: ELF_BYTES })).toEqual({ kind: "refused", reason: "a program" })
  })

  test("a plain zip is still an archive", () => {
    expect(classifyFile({ name: "a.zip", head: zip })).toEqual({ kind: "archive", format: "zip" })
    expect(classifyFile({ name: "docx", head: zip })).toEqual({ kind: "archive", format: "zip" })
  })
})

describe("documents with macros", () => {
  test.each("docm xlsm pptm xlsb dotm xltm potm ppsm sldm xlam ppam".split(" "))(
    ".%s is refused, whatever its bytes",
    (extension) => {
      expect(classifyFile({ name: `report.${extension}`, head: zip })).toEqual(MACROS)
      expect(classifyFile({ name: `REPORT.${extension.toUpperCase()}`, head: text })).toEqual(MACROS)
    },
  )

  test.each([
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "application/vnd.ms-word.document.macroEnabled.12",
    "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
    "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    "application/vnd.ms-excel.addin.macroEnabled.12",
  ])("a declared type of %s is refused", (type) => {
    expect(classifyFile({ name: "report.docx", type, head: zip })).toEqual(MACROS)
    expect(classifyFile({ type, head: text })).toEqual(MACROS)
  })

  test("the macro-free types of the same applications are not", () => {
    expect(classifyFile({ type: "application/vnd.ms-excel", head: text })).toEqual(FILE)
    expect(classifyFile({ type: "application/vnd.ms-powerpoint", head: text })).toEqual(FILE)
  })
})
