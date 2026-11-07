import { afterAll, describe, expect, test } from "bun:test"
import { createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import { buildTar } from "./tar.testing"
import { buildZip, type ZipEntry } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const file = (name: string): ZipEntry => ({ name, data: "a" })
const dir = (name: string): ZipEntry => ({ name, dir: true })
const inspectZip = (entries: ZipEntry[]) => inspectArchive(fixtures.write("n.zip", buildZip(entries)), "zip")
const refuseZip = (entries: ZipEntry[]) => refusal(() => inspectZip(entries))

describe("a name that is not a plain relative path", () => {
  test.each([
    ["../x", "a parent component"],
    ["a/../../x", "a parent component in the middle"],
    ["a/..", "a parent component at the end"],
    ["..", "only a parent component"],
    ["./x", "a current-directory component"],
    ["a/./b", "a current-directory component in the middle"],
    ["/etc/x", "an absolute path"],
    ["C:\\x", "a drive letter with a backslash"],
    ["C:x", "a drive letter"],
    ["c:/x", "a drive letter with a slash"],
    ["a:b/c", "a colon in the first component"],
    ["a\\b", "a backslash"],
    ["..\\x", "a backslash parent"],
    ["a//b", "an empty component"],
    ["a/ /b", "a component of only a space"],
    ["a/.. /b", "a parent component padded with a space, which Windows reads as a parent"],
    ["a/.../b", "a component of only dots"],
    ["a\0b", "a NUL"],
  ])("refuses %j: %s", async (name) => {
    const error = await refuseZip([file("fine.txt"), file(name)])
    expect(error.reason).toStartWith("a path that is not a plain relative one")
    expect(error.entry).toBeDefined()
  })

  test("refuses a component over 255 bytes and a path over 1024, counted in bytes", async () => {
    expect((await refuseZip([file("a".repeat(256))])).reason).toContain("over 255 bytes")
    expect((await refuseZip([file("あ".repeat(86))])).reason).toContain("over 255 bytes")
    expect((await refuseZip([file(`${"d".repeat(100)}/`.repeat(11) + "f")])).reason).toContain("over 1024 bytes")
  })

  test("accepts the longest a component and a path may be", async () => {
    const long = ["b", "c", "d", "e"].map((letter) => letter.repeat(255)).join("/")
    expect(long.length).toBe(1023)
    expect((await inspectZip([file("a".repeat(255)), file(long)])).files).toBe(2)
  })

  test("accepts dots inside names and one trailing slash on a directory", async () => {
    const listing = await inspectZip([dir("a/"), file("a/.hidden"), file("a/x..y"), file("a/b-c.txt")])
    expect(listing.files).toBe(3)
  })

  test("names the entry by its cleaned name", async () => {
    const error = await refuseZip([file("evil\u202E/../x")])
    expect(error.entry).toBe("evil?/../x")
    expect(error.message).toStartWith("the entry evil?/../x is ")
  })
})

describe("two entries that collide once unpacked", () => {
  test.each([
    ["the same path twice", [file("a.txt"), file("a.txt")]],
    ["paths that differ in case", [file("Readme.txt"), file("README.TXT")]],
    ["paths that differ in Unicode form", [file("caf\u00E9.txt"), file("cafe\u0301.txt")]],
    ["folded sharp s", [file("stra\u00DFe.txt"), file("STRASSE.txt")]],
    ["a directory under two cases", [dir("Docs/"), dir("docs/")]],
    ["a file and then a directory of the same name", [file("a"), dir("a/")]],
    ["a directory and then a file of the same name", [dir("a/"), file("a")]],
    ["a file whose directory was already used", [file("a/b"), file("a")]],
  ])("refuses %s", async (_label, entries) => {
    const error = await refuseZip(entries)
    expect(error.reason).toMatch(/second entry|also a directory/)
  })

  test("refuses a file under a path that is a file", async () => {
    const error = await refuseZip([file("a"), file("a/b")])
    expect(error.reason).toBe("inside a path that is also a file")
  })

  test("refuses a file under a path that is a file in another case", async () => {
    expect((await refuseZip([file("A"), file("a/b")])).reason).toBe("inside a path that is also a file")
  })

  test("accepts files under directories, listed or implied", async () => {
    const listing = await inspectZip([file("x/y/z.txt"), dir("x/"), file("x/y/w.txt"), file("other.txt")])
    expect(listing.files).toBe(3)
  })
})

describe("a name with a control or bidi control character", () => {
  test.each([
    ["a C0 control", "bell\u0007.txt"],
    ["a newline", "line\nbreak.txt"],
    ["an escape", "esc\u001B[31m.txt"],
    ["DEL", "del\u007F.txt"],
    ["a C1 control", "next\u0085line.txt"],
    ["the last C1 control", "x\u009F.txt"],
    ["the Arabic letter mark", "a\u061Cb.txt"],
    ["the left-to-right mark", "a\u200Eb.txt"],
    ["the right-to-left mark", "a\u200Fb.txt"],
    ["the right-to-left override", "invoice\u202Etxt.pdf"],
    ["the left-to-right embedding", "a\u202Ab.txt"],
    ["a bidi isolate", "a\u2066b.txt"],
    ["a pop isolate", "a\u2069b.txt"],
    ["one in a directory name", "dir\u202E/ok.txt"],
  ])("is refused: %s", async (_label, name) => {
    const error = await refuseZip([file(name)])
    expect(error.reason).toBe("a name with control or direction-changing characters")
    expect(error.entry).toContain("?")
  })

  test("is refused in a tar as well", async () => {
    const tar = buildTar([{ name: "a\u202Eb.txt", data: "a" }])
    const error = await refusal(() => inspectArchive(fixtures.write("n.tar", tar), "tar"))
    expect(error.reason).toBe("a name with control or direction-changing characters")
  })
})

describe("names in the listing", () => {
  test("shows other invisible characters as ? and keeps the rest", async () => {
    const listing = await inspectZip([
      file("pay\u200Bment.txt"),
      file("日本語\u{E0001}.txt"),
      file("word\u2060joiner.txt"),
      file("\uFEFFbom.txt"),
      file("👨\u200D👩.txt"),
      file("می\u200Cخواهم.txt"),
    ])
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      "pay?ment.txt",
      "日本語?.txt",
      "word?joiner.txt",
      "?bom.txt",
      "👨?👩.txt",
      "می?خواهم.txt",
    ])
  })

  test("shows a name in NFC and cuts a long one to 255 characters", async () => {
    const listing = await inspectZip([file("cafe\u0301.txt"), file(`${"b".repeat(250)}/${"c".repeat(250)}`)])
    expect(listing.entries[0]!.name).toBe("caf\u00E9.txt")
    expect(Array.from(listing.entries[1]!.name)).toHaveLength(255)
    expect(listing.entries[1]!.name.endsWith("…")).toBe(true)
  })
})
