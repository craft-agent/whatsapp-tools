import { afterAll, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { ELF_BYTES, MACHO_BYTES, PE_BYTES, createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import { TAR_END, buildTar, tarEntry } from "./tar.testing"
import { buildZip } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const refuseZipWith = (name: string, data: Buffer | string) =>
  refusal(() =>
    inspectArchive(
      fixtures.write(
        "c.zip",
        buildZip([
          { name: "ok.txt", data: "a" },
          { name, data },
        ]),
      ),
      "zip",
    ),
  )
const refuseTarWith = (name: string, data: Buffer | string) =>
  refusal(() => inspectArchive(fixtures.write("c.tar", buildTar([{ name, data }])), "tar"))

const innerZip = () => buildZip([{ name: "inner.txt", data: "a" }])
const innerTar = () => buildTar([{ name: "inner.txt", data: "a" }])

describe("a program hidden in an archive", () => {
  test.each([
    ["ELF", ELF_BYTES],
    ["Mach-O", MACHO_BYTES],
    ["PE", PE_BYTES],
  ])("is found by its bytes under an innocent name: %s", async (_label, bytes) => {
    for (const refuse of [refuseZipWith, refuseTarWith]) {
      const error = await refuse("docs/notes.txt", bytes)
      expect(error).toMatchObject({ entry: "docs/notes.txt", reason: "a program" })
      expect(error.message).toBe("the entry docs/notes.txt is a program")
    }
  })

  test.each([
    ["tool.exe", "a program"],
    ["Setup.MSI", "an installer"],
    ["setup.msp", "an installer"],
    ["x.lnk", "a program"],
    ["x.jar", "an app package"],
    ["disk.dmg", "a disk image"],
  ])("is found by its name with harmless bytes: %s", async (name, reason) => {
    expect((await refuseZipWith(name, "harmless")).reason).toBe(reason)
    expect((await refuseTarWith(name, "harmless")).reason).toBe(reason)
  })
})

describe("an archive inside an archive", () => {
  test("is refused in zip form, named or not", async () => {
    for (const name of ["inner.zip", "data.bin", "photo.jpg"]) {
      const error = await refuseZipWith(name, innerZip())
      expect(error).toMatchObject({ entry: name, reason: "an archive inside the archive (zip)" })
    }
  })

  test("is refused in tar and gzipped tar form", async () => {
    expect((await refuseZipWith("inner.tar", innerTar())).reason).toBe("an archive inside the archive (tar)")
    expect((await refuseZipWith("inner.tar.gz", gzipSync(innerTar()))).reason).toBe(
      "an archive inside the archive (gzipped tar)",
    )
    expect((await refuseTarWith("data.bin", gzipSync("anything"))).reason).toBe(
      "an archive inside the archive (gzipped tar)",
    )
  })

  test("is refused when it cannot be inspected either", async () => {
    const sevenZip = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 0, 0, 0, 0])
    expect((await refuseZipWith("data.bin", sevenZip)).reason).toBe("an archive that cannot be inspected (7z)")
    expect((await refuseTarWith("data.rar", "plain")).reason).toBe("an archive that cannot be inspected (rar)")
    expect((await refuseTarWith("data.tar.xz", "plain")).reason).toBe("an archive that cannot be inspected (xz)")
  })

  test("is refused inside a gzipped tar, too", async () => {
    const tgz = gzipSync(buildTar([{ name: "inner.bin", data: ELF_BYTES }]))
    const error = await refusal(() => inspectArchive(fixtures.write("c.tgz", tgz), "tgz"))
    expect(error.reason).toBe("a program")
  })

  test("is refused when a tar holds an empty tar", async () => {
    const error = await refuseTarWith("empty.tar", Buffer.concat([tarEntry({ name: "e", data: "a" }), TAR_END]))
    expect(error.reason).toBe("an archive inside the archive (tar)")
  })
})

describe("a file that is not a program or an archive", () => {
  test("passes whatever its size, as long as its first bytes are harmless", async () => {
    const data = Buffer.concat([Buffer.from("plain text start\n"), ELF_BYTES])
    const listing = await inspectArchive(fixtures.write("ok.zip", buildZip([{ name: "mixed.txt", data }])), "zip")
    expect(listing.files).toBe(1)
  })

  test("is read to its end even when the handler stops at the first bytes", async () => {
    const data = Buffer.alloc(200_000, 0x61)
    const lying = buildZip([{ name: "big.txt", data, crc: 1 }])
    const error = await refusal(() => inspectArchive(fixtures.write("l.zip", lying), "zip"))
    expect(error.reason).toContain("checksum")
  })
})
