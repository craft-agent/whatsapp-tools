import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { ELF_BYTES } from "../archive/archive.testing"
import { DEFAULT_LIMITS } from "../archive/limits"
import { buildTar } from "../archive/tar.testing"
import { buildZip, type ZipEntry } from "../archive/zip.testing"
import { MESSAGE_ID, createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
})
afterEach(() => t.close())

const SMALL_LIMITS = { ...DEFAULT_LIMITS, maxTotalSize: 100 * 1024 }

async function save(name: string, bytes: Buffer, host = {}) {
  t.message({ name, type: "" })
  t.respond(download(bytes))
  return t.save(saveArgs(), { host })
}

/** Nothing of the message is left: no saved file, no private copy, no downloaded file. */
function expectNothingLeft() {
  expect(readdirSync(t.folder)).toEqual([])
  expect(t.siblings()).toEqual([MESSAGE_ID])
}

describe("what a hostile archive does", () => {
  test("is refused with the reason and removed, not saved", async () => {
    const hostile = buildZip([
      { name: "docs/readme.txt", data: "hi" },
      { name: "docs/run.sh.exe", data: "x" },
    ])
    const result = await save("docs.zip", hostile)
    expect(result.file).toBeUndefined()
    expect(result.refused).toEqual({ name: "docs.zip", reason: "the entry docs/run.sh.exe is a program" })
    expectNothingLeft()
  })

  test.each<[string, ZipEntry[], string]>([
    ["zip slip", [{ name: "../evil.txt", data: "x" }], "not a plain relative one"],
    ["an ELF under a plain name", [{ name: "data.bin", data: ELF_BYTES }], "is a program"],
    [
      "a nested archive",
      [{ name: "inner.zip", data: buildZip([{ name: "a", data: "b" }]) }],
      "archive inside the archive",
    ],
    ["a bundle", [{ name: "X.app/Contents/run", data: "#!/bin/sh" }], "app or system bundle"],
  ])("%s is refused and nothing is left", async (_label, entries, reason) => {
    const result = await save("x.zip", buildZip(entries))
    expect(result.refused!.reason).toContain(reason)
    expectNothingLeft()
  })

  test("a zip bomb is refused by what it unpacks to, under a small limit, and nothing is left", async () => {
    const bomb = buildZip([{ name: "zeros.bin", data: Buffer.alloc(4_000_000) }])
    expect(bomb.length).toBeLessThan(10_000)
    const result = await save("bomb.zip", bomb, { limits: SMALL_LIMITS })
    expect(result.refused).toEqual({ name: "bomb.zip", reason: "the archive unpacks to more than 102400 bytes" })
    expectNothingLeft()
  })

  test("a gzipped tar bomb is refused the same way", async () => {
    const bomb = gzipSync(buildTar([{ name: "zeros.bin", data: Buffer.alloc(4_000_000) }]))
    const result = await save("bomb.tar.gz", bomb, { limits: SMALL_LIMITS })
    expect(result.refused!.reason).toContain("unpacks to more than")
    expectNothingLeft()
  })

  test("an archive that is large but within the limits is saved and listed", async () => {
    const big = buildZip([{ name: "zeros.bin", data: Buffer.alloc(2_000_000) }])
    const result = await save("big.zip", big)
    expect(result.file!.archive).toMatchObject({ format: "zip", files: 1, total_size: 2_000_000 })
    expect(readFileSync(join(t.folder, "big.zip")).length).toBe(big.length)
  })
})
