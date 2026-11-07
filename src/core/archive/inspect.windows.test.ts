import { afterAll, describe, expect, test } from "bun:test"
import { createFixtures, refusal } from "./archive.testing"
import { bundleProblem } from "./entry-names"
import { inspectArchive } from "./inspect"
import { buildTar } from "./tar.testing"
import { buildZip, type ZipEntry } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const NOT_PLAIN = "a path that is not a plain relative one"
const file = (name: string): ZipEntry => ({ name, data: "a" })
const inspectZip = (entries: ZipEntry[]) => inspectArchive(fixtures.write("w.zip", buildZip(entries)), "zip")
const refuseZip = (entries: ZipEntry[]) => refusal(() => inspectZip(entries))

describe("names that mean something else on Windows", () => {
  test.each([
    ["a colon in the last component, which starts an alternate data stream", "docs/report.txt:payload.exe"],
    ["a colon in a middle component", "a/b:c/d.txt"],
    ["a colon in a directory name", "stream:name/"],
    ["a trailing dot", "docs/report.txt."],
    ["a trailing space", "docs/report.txt "],
    ["several trailing dots and spaces", "docs/report. . "],
    ["a directory with a trailing dot", "docs./file.txt"],
    ["a directory with a trailing space", "docs /file.txt"],
  ])("refuses %s", async (_label, name) => {
    const error = await refuseZip([file("fine.txt"), name.endsWith("/") ? { name, dir: true } : file(name)])
    expect(error.reason).toStartWith(NOT_PLAIN)
    expect(error.reason).toMatch(/colon|ends in a dot or a space/)
  })

  test.each([
    "CON",
    "con",
    "Prn",
    "AUX",
    "nul",
    "COM0",
    "COM1",
    "com9",
    "LPT0",
    "lpt5",
    "LPT9",
    "COM\u00B9",
    "COM\u00B2",
    "COM\u00B3",
    "LPT\u00B9",
    "lpt\u00B2",
    "CONIN$",
    "conout$",
  ])("refuses the device name %s, bare or with an extension, at any depth", async (device) => {
    for (const name of [device, `${device}.txt`, `${device}.tar.gz`, `dir/${device}`, `${device}/inner.txt`]) {
      const error = await refuseZip([file(name)])
      expect(error.reason).toBe(`${NOT_PLAIN} (a component is a name Windows reserves for a device)`)
    }
  })

  test("refuses a device name with spaces before the extension, in a tar too", async () => {
    expect((await refuseZip([file("CON .txt")])).reason).toContain("reserves for a device")
    const tar = buildTar([{ name: "nul.txt", data: "a" }])
    const error = await refusal(() => inspectArchive(fixtures.write("w.tar", tar), "tar"))
    expect(error.reason).toContain("reserves for a device")
  })

  test("accepts names that only contain a device name or end in one", async () => {
    const listing = await inspectZip([
      file("console.txt"),
      file("print.txt"),
      file("com10.txt"),
      file("com.txt"),
      file("lpt.txt"),
      file("my.con"),
      file("a.nul"),
      file("COM1x"),
      file("xcon"),
      file("auxiliary/nulled"),
    ])
    expect(listing.files).toBe(10)
  })

  test("still reads a bundle name with trailing dots and spaces as a bundle, for a caller that keeps such names", () => {
    expect(bundleProblem("Thing.app. ./x")).toBe("an app or system bundle")
  })
})
