import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createFixtures, type Fixtures } from "../archive/archive.testing"
import { buildZip } from "../archive/zip.testing"
import { abortWhen, treeOf } from "./unpack.testing"
import { unpackArchive } from "./unpack"

let fixtures: Fixtures

beforeEach(() => {
  fixtures = createFixtures()
})
afterEach(() => fixtures.remove())

const zip = () =>
  buildZip([
    { name: "top.txt", data: "top" },
    { name: "docs", dir: true },
    { name: "docs/readme.txt", data: "hello" },
    { name: "deep/er/data.bin", data: Buffer.from([1, 2, 3]) },
    { name: "empty-dir", dir: true },
  ])

/** The folder `name` is written to inside the fixtures' folder, with the archive in it. */
const folderWith = (name: string, bytes: Buffer) => fixtures.write(name, bytes).replace(new RegExp(`${name}$`), "")

describe("an unpack that fails midway", () => {
  /** Whether a staging folder of unpacking in `folder` has had something written in it. */
  const somethingWritten = (folder: string) =>
    readdirSync(folder).some((name) => name.endsWith(".unpacking") && readdirSync(join(folder, name)).length > 0)

  test("removes the staging folder, the private copy and everything written, leaving only the archive", async () => {
    const folder = folderWith("pack.zip", zip())
    const archivePath = join(folder, "pack.zip")
    // stopped at the first check after a file has been created below the staging folder
    const signal = abortWhen(() => somethingWritten(folder))

    await expect(unpackArchive({ archivePath, name: "pack.zip", folder, signal })).rejects.toMatchObject({
      name: "AbortError",
    })

    expect(readdirSync(folder)).toEqual(["pack.zip"])
  })

  test("stops promptly in the middle of a large entry, between two chunks of its data", async () => {
    const big = buildZip([{ name: "big.bin", data: Buffer.alloc(3_000_000, 0x61), method: "stored" }])
    const folder = folderWith("big.zip", big)
    let sizeWhenStopped = -1
    const signal = abortWhen(() => {
      const staging = readdirSync(folder).find((name) => name.endsWith(".unpacking"))
      if (staging === undefined || !existsSync(join(folder, staging, "big.bin"))) return false
      sizeWhenStopped = statSync(join(folder, staging, "big.bin")).size
      return sizeWhenStopped > 0
    })
    await expect(
      unpackArchive({ archivePath: join(folder, "big.zip"), name: "big.zip", folder, signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(sizeWhenStopped).toBeGreaterThan(0)
    expect(sizeWhenStopped).toBeLessThan(3_000_000)
    expect(readdirSync(folder)).toEqual(["big.zip"])
  })

  test("is stopped by the signal while the copy of the archive is inspected", async () => {
    const folder = folderWith("pack.zip", zip())
    let checks = 0
    // the copy takes two checks; the inspection that follows is the next ones, before any staging folder exists
    const signal = abortWhen(() => ++checks > 4 && !readdirSync(folder).some((name) => name.endsWith(".unpacking")))
    await expect(
      unpackArchive({ archivePath: join(folder, "pack.zip"), name: "pack.zip", folder, signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(readdirSync(folder)).toEqual(["pack.zip"])
  })

  test("does the same when the archive turns out not to be one any more", async () => {
    const folder = folderWith("pack.zip", Buffer.from("no longer an archive"))
    await expect(unpackArchive({ archivePath: join(folder, "pack.zip"), name: "pack.zip", folder })).rejects.toThrow()
    expect(readdirSync(folder)).toEqual(["pack.zip"])
  })

  test("unpacks the same archive when nothing stops it", async () => {
    const folder = folderWith("pack.zip", zip())
    const unpacked = await unpackArchive({ archivePath: join(folder, "pack.zip"), name: "pack.zip", folder })
    expect(unpacked.alreadyUnpacked).toBe(false)
    expect(readdirSync(folder).sort()).toEqual(["pack.zip", "pack.zip.unpacked"])
  })
})

describe("publishing the unpacked folder", () => {
  test("never replaces what has been put in the folder meanwhile: the next name is taken", async () => {
    const folder = folderWith("pack.zip", zip())
    const targets: string[] = []
    const beforeRename = (target: string) => {
      targets.push(target)
      // someone fills the folder that was just made, after it was made and before the rename
      if (targets.length === 1) writeFileSync(join(target, "theirs.txt"), "not ours")
    }

    const unpacked = await unpackArchive({
      archivePath: join(folder, "pack.zip"),
      name: "pack.zip",
      folder,
      beforeRename,
    })

    expect(targets.map((target) => target.replace(folder, ""))).toEqual(["pack.zip.unpacked", "pack.zip (2).unpacked"])
    expect(unpacked.path).toBe(join(folder, "pack.zip (2).unpacked"))
    expect(readdirSync(join(folder, "pack.zip.unpacked"))).toEqual(["theirs.txt"])
    expect(readFileSync(join(folder, "pack.zip.unpacked", "theirs.txt"), "utf8")).toBe("not ours")
    expect(treeOf(unpacked.path)).toContain("docs/readme.txt")
    expect(readdirSync(folder).filter((name) => name.startsWith("."))).toEqual([])
  })

  test("removes the folder it made again when it is still empty and the rename fails", async () => {
    const folder = folderWith("pack.zip", zip())
    const boom = new Error("rename would have failed")
    await expect(
      unpackArchive({
        archivePath: join(folder, "pack.zip"),
        name: "pack.zip",
        folder,
        beforeRename: () => {
          throw boom
        },
      }),
    ).rejects.toBe(boom)
    expect(readdirSync(folder)).toEqual(["pack.zip"])
  })

  test("makes the folder itself, so a name that is taken in any form is never replaced", async () => {
    const folder = folderWith("pack.zip", zip())
    writeFileSync(join(folder, "pack.zip.unpacked"), "a file")
    symlinkSync(join(folder, "elsewhere"), join(folder, "pack.zip (2).unpacked"))
    const unpacked = await unpackArchive({ archivePath: join(folder, "pack.zip"), name: "pack.zip", folder })
    expect(unpacked.path).toBe(join(folder, "pack.zip (3).unpacked"))
    expect(readFileSync(join(folder, "pack.zip.unpacked"), "utf8")).toBe("a file")
  })
})
