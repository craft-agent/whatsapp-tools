import { describe, expect, test } from "bun:test"
import { ELF_BYTES, MACHO_BYTES, PE_BYTES } from "./archive.testing"
import { CLASSIFY_HEAD_BYTES, classifyFile, type FileKind } from "./kind"

const refused = (reason: string): FileKind => ({ kind: "refused", reason })
const FILE: FileKind = { kind: "file" }
const text = Buffer.from("just some plain text\n")
const padded = (...parts: Array<number[] | Buffer>) =>
  Buffer.concat([...parts.map((part) => Buffer.from(part)), Buffer.alloc(64)])

describe("programs by their first bytes", () => {
  test.each([
    ["ELF", ELF_BYTES],
    ["32-bit Mach-O", padded([0xfe, 0xed, 0xfa, 0xce])],
    ["64-bit Mach-O", MACHO_BYTES],
    ["big-endian 64-bit Mach-O", padded([0xfe, 0xed, 0xfa, 0xcf])],
    ["32-bit little-endian Mach-O", padded([0xce, 0xfa, 0xed, 0xfe])],
    ["universal Mach-O", padded([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])],
    ["little-endian universal Mach-O", padded([0xbe, 0xba, 0xfe, 0xca])],
    ["universal Mach-O with 64-bit offsets", padded([0xca, 0xfe, 0xba, 0xbf])],
    ["Java class", padded([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34])],
    ["PE", PE_BYTES],
    ["DOS executable", padded([0x4d, 0x5a], Buffer.alloc(0x3e))],
    ["WebAssembly", padded([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])],
    ["Windows shortcut", padded([0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00])],
  ])("%s is a program, whatever the name and the declared type", (_label, head) => {
    expect(classifyFile({ head })).toEqual(refused("a program"))
    expect(classifyFile({ name: "notes.txt", type: "text/plain", head })).toEqual(refused("a program"))
    expect(classifyFile({ name: "photo.png", type: "image/png", head })).toEqual(refused("a program"))
  })

  test.each([
    ["macOS installer package", "xar!\0\0\0\0", "an installer"],
    ["RPM package", "\xED\xAB\xEE\xDB\x03\x00", "an installer"],
    ["Debian package", "!<arch>\ndebian-binary   ", "an installer"],
  ])("%s is an installer by its bytes", (_label, bytes, reason) => {
    expect(classifyFile({ name: "readme.txt", head: Buffer.from(bytes, "latin1") })).toEqual(refused(reason))
  })

  test("an ar archive that is not a Debian package cannot be inspected", () => {
    expect(classifyFile({ head: Buffer.from("!<arch>\nlibx.o/ 0 0") })).toEqual(
      refused("an archive that cannot be inspected (ar)"),
    )
  })

  test("a file starting with MZ is a program only when the DOS header follows", () => {
    expect(
      classifyFile({ name: "notes.txt", head: Buffer.from("MZ is the code of the Mozambique metical\n") }),
    ).toEqual(FILE)
    expect(classifyFile({ head: Buffer.from("MZ") })).toEqual(FILE)
  })

  test("OLE compound bytes alone are not an installer: they are also .doc and .xls", () => {
    const ole = padded([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect(classifyFile({ name: "report.doc", type: "application/msword", head: ole })).toEqual(FILE)
    expect(classifyFile({ name: "report.xls", head: ole })).toEqual(FILE)
    expect(classifyFile({ name: "setup.msi", head: ole })).toEqual(refused("an installer"))
  })

  test("a small file with the first bytes of a program but too few to tell is judged by what there is", () => {
    expect(classifyFile({ head: Buffer.from([0x7f, 0x45, 0x4c]) })).toEqual(FILE)
    expect(classifyFile({ head: new Uint8Array(0) })).toEqual(FILE)
  })

  test("reads no more than the head it is given", () => {
    const head = Buffer.alloc(CLASSIFY_HEAD_BYTES)
    expect(classifyFile({ head })).toEqual(FILE)
  })
})

describe("programs and installers by name", () => {
  test.each([
    ...["exe", "com", "scr", "cpl", "hta", "msc", "reg", "inf", "lnk", "dll", "sys", "class", "wasm", "so", "dylib"],
    ...["app", "workflow", "kext", "plugin", "prefpane", "command", "terminal", "tool", "jnlp", "elf"],
  ])("refuses .%s as a program", (extension) => {
    expect(classifyFile({ name: `thing.${extension}`, head: text })).toEqual(refused("a program"))
  })

  test.each(["msi", "msp", "pkg", "mpkg", "deb", "rpm", "appimage", "msix", "appx", "snap", "flatpak"])(
    "refuses .%s as an installer",
    (extension) => {
      expect(classifyFile({ name: `thing.${extension}`, head: text })).toEqual(refused("an installer"))
    },
  )

  test.each(["apk", "aab", "ipa", "jar", "war", "xpi", "crx"])("refuses .%s as an app package", (extension) => {
    expect(classifyFile({ name: `thing.${extension}`, head: text })).toEqual(refused("an app package"))
  })

  test("refuses an app package whose bytes are a plain zip", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0])
    expect(classifyFile({ name: "app.apk", head: zip })).toEqual(refused("an app package"))
    expect(classifyFile({ name: "lib.JAR", head: zip })).toEqual(refused("an app package"))
  })

  test("refuses .dmg as a disk image", () => {
    expect(classifyFile({ name: "install.dmg", head: text })).toEqual(refused("a disk image"))
  })

  test("judges the name case-insensitively, by its last extension, and in any folder", () => {
    for (const name of ["TOOL.EXE", "Tool.Exe", "dir/tool.exe", "C:\\dir\\tool.exe", "archive.tar.gz.exe", ".exe"]) {
      expect(classifyFile({ name, head: text })).toEqual(refused("a program"))
    }
  })

  test("reads the extension as Windows does: without trailing dots and spaces, and up to a NUL", () => {
    for (const name of ["tool.exe.", "tool.exe  ", "tool.exe. . ", "tool.exe\0.txt"]) {
      expect(classifyFile({ name, head: text })).toEqual(refused("a program"))
    }
  })

  test("saves source code as text: it runs only if someone runs it", () => {
    for (const name of ["run.bat", "run.cmd", "script.ps1", "script.vbs", "app.js", "x.wsf", "x.wsh", "x.sh", "x.py"]) {
      expect(classifyFile({ name, head: text })).toEqual(FILE)
    }
  })

  test("does not refuse a name that only contains a program's extension", () => {
    for (const name of ["exe", "my.exe.txt", "notes.exe.bak", "app.application.md", "readme"]) {
      expect(classifyFile({ name, head: text })).toEqual(FILE)
    }
  })
})

describe("programs and archives by declared type", () => {
  test.each([
    ["application/x-msdownload", "a program"],
    ["application/x-dosexec", "a program"],
    ["application/vnd.microsoft.portable-executable", "a program"],
    ["application/x-executable", "a program"],
    ["application/x-mach-binary", "a program"],
    ["application/wasm", "a program"],
    ["application/x-msi", "an installer"],
    ["application/x-rpm", "an installer"],
    ["application/vnd.debian.binary-package", "an installer"],
    ["application/java-archive", "an app package"],
    ["application/vnd.android.package-archive", "an app package"],
    ["application/x-apple-diskimage", "a disk image"],
    ["application/x-7z-compressed", "an archive that cannot be inspected (7z)"],
    ["application/vnd.rar", "an archive that cannot be inspected (rar)"],
    ["application/x-bzip2", "an archive that cannot be inspected (bzip2)"],
    ["application/x-xz", "an archive that cannot be inspected (xz)"],
    ["application/zstd", "an archive that cannot be inspected (zstd)"],
    ["application/x-iso9660-image", "an archive that cannot be inspected (iso)"],
  ])("refuses %s", (type, reason) => {
    expect(classifyFile({ name: "download", type, head: text })).toEqual(refused(reason))
  })

  test("reads the type in any case and without its parameters", () => {
    expect(classifyFile({ type: "Application/X-MSDownload; charset=binary", head: text })).toEqual(refused("a program"))
    expect(classifyFile({ type: "  application/x-msi ", head: text })).toEqual(refused("an installer"))
  })

  test("accepts the types of ordinary files", () => {
    for (const type of ["text/plain", "image/png", "application/pdf", "application/octet-stream", "video/mp4", ""]) {
      expect(classifyFile({ name: "file", type, head: text })).toEqual(FILE)
    }
  })

  test("a lying type does not hide bytes: image/png over a PE is still a program", () => {
    expect(classifyFile({ name: "cat.png", type: "image/png", head: PE_BYTES })).toEqual(refused("a program"))
  })
})
