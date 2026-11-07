import { afterAll, describe, expect, test } from "bun:test"
import { createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import { buildTar } from "./tar.testing"
import { buildZip, type ZipEntry } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const BUNDLE = "an app or system bundle"
const script = "#!/bin/sh\necho hi\n"
const refuseZip = (entries: ZipEntry[]) =>
  refusal(() => inspectArchive(fixtures.write("b.zip", buildZip(entries)), "zip"))

describe("a path through a bundle", () => {
  test("refuses an innocent script inside an app, naming the entry", async () => {
    const error = await refuseZip([{ name: "X.app/Contents/MacOS/x", data: script }])
    expect(error).toMatchObject({ reason: BUNDLE, entry: "X.app/Contents/MacOS/x" })
    expect(error.message).toBe("the entry X.app/Contents/MacOS/x is an app or system bundle")
  })

  test("refuses a directory entry that is a bundle", async () => {
    expect((await refuseZip([{ name: "Y.kext/", dir: true }])).reason).toBe(BUNDLE)
  })

  test.each(
    "app framework bundle kext plugin prefpane workflow action appex xpc qlgenerator mdimporter saver component mpkg pkg dSYM".split(
      " ",
    ),
  )("refuses a .%s component, in any case", async (extension) => {
    for (const name of [`Thing.${extension}/`, `deep/dir/Thing.${extension.toUpperCase()}/file.txt`]) {
      const error = await refuseZip([name.endsWith("/") ? { name, dir: true } : { name, data: "a" }])
      expect(error.reason).toBe(BUNDLE)
    }
  })

  test("refuses a bundle that is a file", async () => {
    expect((await refuseZip([{ name: "docs/Thing.pkg", data: "a" }])).reason).toBe(BUNDLE)
  })

  test("refuses it in a tar", async () => {
    const tar = buildTar([{ name: "X.app/run", data: script }])
    expect((await refusal(() => inspectArchive(fixtures.write("b.tar", tar), "tar"))).reason).toBe(BUNDLE)
  })

  test("accepts names that only look like one", async () => {
    const listing = await inspectArchive(
      fixtures.write(
        "ok.zip",
        buildZip([
          { name: "app/", dir: true },
          { name: "app/application.txt", data: "a" },
          { name: "my.app.notes/readme.txt", data: "a" },
          { name: "pkg", data: "a" },
          { name: "frameworks/x.txt", data: "a" },
        ]),
      ),
      "zip",
    )
    expect(listing.files).toBe(4)
  })
})
