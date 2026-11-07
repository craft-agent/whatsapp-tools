import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { ELF_BYTES } from "./archive.testing"
import { classifyFile, type ArchiveFormat, type FileKind } from "./kind"
import { TAR_END, buildTar } from "./tar.testing"
import { buildZip } from "./zip.testing"

const FILE: FileKind = { kind: "file" }
const archive = (format: ArchiveFormat): FileKind => ({ kind: "archive", format })
const mislabeled = (claim: string): FileKind => ({
  kind: "refused",
  reason: `mislabeled (its name or type says ${claim}, its bytes do not)`,
})
const unreadable = (label: string): FileKind => ({
  kind: "refused",
  reason: `an archive that cannot be inspected (${label})`,
})

const zipBytes = buildZip([{ name: "a.txt", data: "a" }])
const emptyZip = buildZip([])
const tarBytes = buildTar([{ name: "a.txt", data: "a" }])
const tgzBytes = gzipSync(tarBytes)
const text = Buffer.from("just some plain text\n")

describe("archives the package can read", () => {
  test("a zip is a zip by its name, its type, or its bytes alone", () => {
    expect(classifyFile({ name: "a.zip", head: zipBytes })).toEqual(archive("zip"))
    expect(classifyFile({ name: "download", type: "application/zip", head: zipBytes })).toEqual(archive("zip"))
    expect(classifyFile({ name: "download", head: zipBytes })).toEqual(archive("zip"))
    expect(classifyFile({ name: "notes.txt", type: "text/plain", head: zipBytes })).toEqual(archive("zip"))
  })

  test("an empty zip is a zip", () => {
    expect(classifyFile({ name: "empty.zip", head: emptyZip })).toEqual(archive("zip"))
  })

  test("a tar is a tar by its name, its type, or its header", () => {
    expect(classifyFile({ name: "a.tar", head: tarBytes })).toEqual(archive("tar"))
    expect(classifyFile({ type: "application/x-tar", head: tarBytes })).toEqual(archive("tar"))
    expect(classifyFile({ name: "backup", head: tarBytes })).toEqual(archive("tar"))
  })

  test("a tar with no magic is still a tar when its checksum is right, and a tar with nothing in it too", () => {
    expect(classifyFile({ name: "old.tar", head: buildTar([{ name: "a", data: "a", magic: "v7" }]) })).toEqual(
      archive("tar"),
    )
    expect(classifyFile({ name: "empty.tar", head: buildTar([]) })).toEqual(archive("tar"))
  })

  test("a gzip is reported as tgz, by .gz, .tgz, .tar.gz, its type, or its bytes", () => {
    for (const name of ["a.gz", "a.tgz", "a.tar.gz", "A.TAR.GZ", "a.tar.gz.", "download"]) {
      expect(classifyFile({ name, head: tgzBytes })).toEqual(archive("tgz"))
    }
    expect(classifyFile({ name: "d", type: "application/gzip", head: tgzBytes })).toEqual(archive("tgz"))
  })

  test("gzip of something that is not a tar is still reported: the inspection finds that out", () => {
    expect(classifyFile({ name: "log.gz", head: gzipSync("text") })).toEqual(archive("tgz"))
  })

  test("a file with nothing archive-like about it is a file", () => {
    expect(classifyFile({ name: "notes.txt", type: "text/plain", head: text })).toEqual(FILE)
    expect(classifyFile({ name: "photo.png", type: "image/png", head: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })).toEqual(
      FILE,
    )
  })
})

describe("a file that says it is an archive and is not", () => {
  test("a .zip whose bytes are text, an empty file, or another archive is mislabeled", () => {
    expect(classifyFile({ name: "a.zip", head: text })).toEqual(mislabeled("zip"))
    expect(classifyFile({ name: "a.zip", head: new Uint8Array(0) })).toEqual(mislabeled("zip"))
    expect(classifyFile({ name: "a.zip", head: tarBytes })).toEqual(mislabeled("zip"))
    expect(classifyFile({ name: "a.zip", head: tgzBytes })).toEqual(mislabeled("zip"))
  })

  test("a .tar, .gz or .tgz whose bytes are something else is mislabeled", () => {
    expect(classifyFile({ name: "a.tar", head: text })).toEqual(mislabeled("tar"))
    expect(classifyFile({ name: "a.tar", head: zipBytes })).toEqual(mislabeled("tar"))
    expect(classifyFile({ name: "a.tar", head: tgzBytes })).toEqual(mislabeled("tar"))
    expect(classifyFile({ name: "a.tgz", head: tarBytes })).toEqual(mislabeled("gzip"))
    expect(classifyFile({ name: "a.gz", head: zipBytes })).toEqual(mislabeled("gzip"))
  })

  test("a type that claims an archive the bytes are not is mislabeled", () => {
    expect(classifyFile({ type: "application/zip", head: text })).toEqual(mislabeled("zip"))
    expect(classifyFile({ type: "application/x-tar", head: zipBytes })).toEqual(mislabeled("tar"))
    expect(classifyFile({ type: "application/gzip", head: zipBytes })).toEqual(mislabeled("gzip"))
  })

  test("a name and a type that name different archives are mislabeled, even over real bytes", () => {
    expect(classifyFile({ name: "a.zip", type: "application/x-tar", head: zipBytes })).toEqual(mislabeled("zip"))
    expect(classifyFile({ name: "a.tar", type: "application/zip", head: tarBytes })).toEqual(mislabeled("tar"))
  })

  test("a name and a type that agree over real bytes are fine", () => {
    expect(classifyFile({ name: "a.zip", type: "application/x-zip-compressed", head: zipBytes })).toEqual(
      archive("zip"),
    )
  })

  test("a file with a lot of zero bytes is not a tar unless something says so", () => {
    const zeros = Buffer.alloc(4096)
    expect(classifyFile({ name: "blank.bin", head: zeros })).toEqual(FILE)
    expect(classifyFile({ name: "blank.tar", head: zeros })).toEqual(archive("tar"))
    expect(classifyFile({ name: "blank.tar", head: Buffer.alloc(100) })).toEqual(mislabeled("tar"))
    expect(classifyFile({ name: "blank.tar", head: TAR_END.subarray(0, 512) })).toEqual(archive("tar"))
  })
})

describe("archives that cannot be inspected", () => {
  test.each([
    ["a.rar", "rar"],
    ["a.7z", "7z"],
    ["a.bz2", "bzip2"],
    ["a.tar.bz2", "bzip2"],
    ["a.tbz2", "bzip2"],
    ["a.xz", "xz"],
    ["a.tar.xz", "xz"],
    ["a.zst", "zstd"],
    ["a.tar.zst", "zstd"],
    ["a.lz", "lzip"],
    ["a.lzma", "lzma"],
    ["a.cab", "cab"],
    ["a.iso", "iso"],
    ["a.img", "img"],
    ["a.cpio", "cpio"],
    ["a.ar", "ar"],
    ["A.RAR", "rar"],
  ])("refuses %s by its name, over harmless bytes", (name, label) => {
    expect(classifyFile({ name, head: text })).toEqual(unreadable(label))
  })

  test.each([
    ["rar", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]],
    ["7z", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]],
    ["bzip2", [...Buffer.from("BZh9"), 0x31, 0x41, 0x59, 0x26, 0x53, 0x59]],
    ["xz", [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04]],
    ["zstd", [0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00]],
    ["lzip", [...Buffer.from("LZIP"), 1, 12]],
    ["lz4", [0x04, 0x22, 0x4d, 0x18, 0x64]],
    ["compress", [0x1f, 0x9d, 0x90]],
    ["cab", [...Buffer.from("MSCF"), 0, 0, 0, 0]],
    ["ar", [...Buffer.from("!<arch>\n"), 0x2f, 0x20]],
  ])("refuses %s by its bytes, under any name", (label, bytes) => {
    const head = Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)])
    expect(classifyFile({ head })).toEqual(unreadable(label))
    expect(classifyFile({ name: "notes.txt", type: "text/plain", head })).toEqual(unreadable(label))
    expect(classifyFile({ name: "a.zip", head })).toEqual(unreadable(label))
  })

  test("does not mistake text that starts like a bzip2 file for one", () => {
    expect(classifyFile({ name: "notes.txt", head: Buffer.from("BZh9 is a block size, not a file") })).toEqual(FILE)
  })

  test("refuses a program that hides as an archive", () => {
    expect(classifyFile({ name: "a.zip", head: ELF_BYTES })).toEqual({ kind: "refused", reason: "a program" })
    expect(classifyFile({ name: "a.tar.gz", type: "application/gzip", head: ELF_BYTES })).toEqual({
      kind: "refused",
      reason: "a program",
    })
  })
})
