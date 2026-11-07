import { describe, expect, test } from "bun:test"
import { plainPathProblem } from "../archive/entry-names"
import { fallbackName, numberedName, safeFileName, unpackedName } from "./names"

const clean = (raw: string | undefined, fallback = "image-3EB0.jpg") => safeFileName(raw, fallback)

describe("safeFileName", () => {
  test("keeps an ordinary name, in NFC", () => {
    expect(clean("report 2026.pdf")).toBe("report 2026.pdf")
    expect(clean("日本語 ファイル.txt")).toBe("日本語 ファイル.txt")
    expect(clean("cafe\u0301.txt")).toBe("caf\u00e9.txt")
  })

  test("replaces path separators, colons and Windows-unsafe characters with _", () => {
    expect(clean("../../etc/passwd")).toBe("_.._.._etc_passwd")
    expect(clean("a\\b/c:d.txt")).toBe("a_b_c_d.txt")
    expect(clean('q<u>o"t|e?s*.txt')).toBe("q_u_o_t_e_s_.txt")
  })

  test("replaces control and bidi control characters with _, and keeps other invisible ones", () => {
    expect(clean("invoice\u202Etxt.pdf")).toBe("invoice_txt.pdf")
    expect(clean("a\u0007b\nc\u007Fd.txt")).toBe("a_b_c_d.txt")
    expect(clean("a\u200Db.txt")).toBe("a\u200Db.txt")
  })

  test("drops trailing dots and spaces and hides a leading dot", () => {
    expect(clean("name.txt. . ")).toBe("name.txt")
    expect(clean("  spaced.txt  ")).toBe("spaced.txt")
    expect(clean(".bashrc")).toBe("_.bashrc")
    expect(clean("..hidden")).toBe("_..hidden")
  })

  test.each(["CON", "con.txt", "Prn.tar.gz", "AUX", "NUL.log", "COM1", "lpt9.txt", "COM\u00b9.txt", "CON .txt"])(
    "prefixes the Windows device name %s with _",
    (name) => {
      expect(clean(name)).toBe(`_${name}`)
      expect(plainPathProblem(clean(name), false)).toBeUndefined()
    },
  )

  test("uses the fallback for a file with no name, or none left", () => {
    expect(clean(undefined)).toBe("image-3EB0.jpg")
    expect(clean("")).toBe("image-3EB0.jpg")
    expect(clean("   ")).toBe("image-3EB0.jpg")
    expect(clean("...")).toBe("image-3EB0.jpg")
  })

  test("cleans the fallback like any name, and ends in file when that leaves nothing", () => {
    expect(clean(undefined, "a/b")).toBe("a_b")
    expect(clean(undefined, "...")).toBe("file")
  })

  test("cuts a long name to 255 bytes of UTF-8, keeping the extension and whole characters", () => {
    const long = clean(`${"あ".repeat(200)}.jpeg`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255)
    expect(long.endsWith(".jpeg")).toBe(true)
    expect(long).not.toContain("\uFFFD")
    expect(clean(`${"a".repeat(300)}.txt`)).toBe(`${"a".repeat(251)}.txt`)
    expect(clean("b".repeat(300))).toBe("b".repeat(255))
  })

  test("always gives a name the archive rules accept as a path component", () => {
    for (const raw of ["CON", "a:b", "x.", " ", "\u0000", "/", "..", "a\u202Eb", "COM1.txt", "ok"]) {
      expect(plainPathProblem(clean(raw), false)).toBeUndefined()
    }
  })
})

describe("fallbackName", () => {
  test("is the media kind, the message id and an extension for the content type", () => {
    expect(fallbackName("image", "3EB0A1", "image/jpeg")).toBe("image-3EB0A1.jpg")
    expect(fallbackName("audio", "3EB0A1", "audio/ogg; codecs=opus")).toBe("audio-3EB0A1.ogg")
    expect(fallbackName("document", "3EB0A1", "application/pdf")).toBe("document-3EB0A1.pdf")
  })

  test.each([
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["image/gif", ".gif"],
    ["video/mp4", ".mp4"],
    ["video/3gpp", ".3gp"],
    ["video/quicktime", ".mov"],
    ["audio/ogg", ".ogg"],
    ["audio/mpeg", ".mp3"],
    ["audio/mp4", ".m4a"],
    ["audio/aac", ".aac"],
    ["audio/amr", ".amr"],
    ["audio/opus", ".opus"],
    ["application/pdf", ".pdf"],
  ])("gives %s the extension %s", (type, extension) => {
    expect(fallbackName("file", "x", type)).toBe(`file-x${extension}`)
  })

  test("has no extension for a type it does not know, or none", () => {
    expect(fallbackName("document", "x", "application/x-unknown")).toBe("document-x")
    expect(fallbackName("document", "x", undefined)).toBe("document-x")
  })

  test("keeps the kind to lower-case letters and digits, and has one when nothing is left", () => {
    expect(fallbackName("Live/Photo", "x", undefined)).toBe("livephoto-x")
    expect(fallbackName("../", "x", undefined)).toBe("file-x")
  })
})

describe("numbering", () => {
  test("puts the number before the extension and keeps the name within 255 bytes", () => {
    expect(numberedName("photo.jpg", 2)).toBe("photo (2).jpg")
    expect(numberedName("notes", 3)).toBe("notes (3)")
    const long = numberedName(`${"a".repeat(251)}.txt`, 12)
    expect(Buffer.byteLength(long)).toBe(255)
    expect(long.endsWith(" (12).txt")).toBe(true)
  })

  test("names the folder an archive is unpacked into, within 255 bytes", () => {
    expect(unpackedName("data.zip")).toBe("data.zip.unpacked")
    expect(unpackedName("data.zip", 2)).toBe("data.zip (2).unpacked")
    expect(Buffer.byteLength(unpackedName(`${"z".repeat(251)}.zip`))).toBeLessThanOrEqual(255)
  })
})
