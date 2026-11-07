import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { buildTar } from "../archive/tar.testing"
import { buildZip } from "../archive/zip.testing"
import { createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"
import { treeOf } from "./unpack.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
})
afterEach(() => t.close())

const zip = () =>
  buildZip([
    { name: "top.txt", data: "top" },
    { name: "docs", dir: true },
    { name: "docs/readme.txt", data: "hello" },
    { name: "deep/er/data.bin", data: Buffer.from([1, 2, 3]) },
    { name: "empty-dir", dir: true },
  ])

async function saveWith(bytes: Buffer, name = "pack.zip", unpack = true) {
  t.message({ name, type: "" })
  t.respond(download(bytes))
  return t.save(saveArgs({ unpack }))
}

const mode = (path: string) => statSync(path).mode & 0o777
const leftovers = (folder: string) => readdirSync(folder).filter((name) => name.startsWith("."))

describe("unpacking a saved archive", () => {
  test("writes the tree beside the archive, folders 0700 and files 0600", async () => {
    const result = await saveWith(zip())
    const target = join(t.folder, "pack.zip.unpacked")
    expect(result.file!.unpacked).toBe(target)
    expect(result.file!.already_unpacked).toBeUndefined()
    expect(treeOf(target)).toEqual([
      "deep/",
      "deep/er/",
      "deep/er/data.bin",
      "docs/",
      "docs/readme.txt",
      "empty-dir/",
      "top.txt",
    ])
    expect(readFileSync(join(target, "docs", "readme.txt"), "utf8")).toBe("hello")
    expect([...readFileSync(join(target, "deep", "er", "data.bin"))]).toEqual([1, 2, 3])
    for (const folder of [target, join(target, "deep"), join(target, "deep", "er"), join(target, "empty-dir")]) {
      expect(mode(folder)).toBe(0o700)
    }
    for (const file of ["top.txt", "docs/readme.txt", "deep/er/data.bin"]) expect(mode(join(target, file))).toBe(0o600)
    expect(leftovers(t.folder)).toEqual([])
    expect(readdirSync(t.folder).sort()).toEqual(["pack.zip", "pack.zip.unpacked"])
  })

  test("unpacks a gzipped tar, and an empty archive into an empty folder", async () => {
    const tgz = gzipSync(buildTar([{ name: "a/b.txt", data: "in a tar" }]))
    const result = await saveWith(tgz, "bundle.tar.gz")
    expect(readFileSync(join(result.file!.unpacked!, "a", "b.txt"), "utf8")).toBe("in a tar")
    const empty = await saveWith(buildZip([]), "nothing.zip")
    expect(treeOf(empty.file!.unpacked!)).toEqual([])
  })

  test("is only done when asked for", async () => {
    await saveWith(zip(), "pack.zip", false)
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
  })

  test("a second call with unpack finds the folder and writes nothing", async () => {
    const first = await saveWith(zip())
    const target = first.file!.unpacked!
    writeFileSync(join(target, "mine.txt"), "added by the user")
    const before = treeOf(t.folder)

    const second = await t.save(saveArgs({ unpack: true }))

    expect(second.file).toMatchObject({ already_saved: true, unpacked: target, already_unpacked: true })
    expect(treeOf(t.folder)).toEqual(before)
    expect(readFileSync(join(target, "mine.txt"), "utf8")).toBe("added by the user")
  })

  test("a second call with unpack unpacks an archive the first call only saved", async () => {
    await saveWith(zip(), "pack.zip", false)
    const second = await t.save(saveArgs({ unpack: true }))
    expect(second.file).toMatchObject({ already_saved: true, unpacked: join(t.folder, "pack.zip.unpacked") })
    expect(treeOf(join(t.folder, "pack.zip.unpacked"))).toContain("docs/readme.txt")
  })

  test("a file already named like the folder is not touched: the unpacked folder is numbered", async () => {
    mkdirSync(t.folder, { recursive: true })
    writeFileSync(join(t.folder, "pack.zip.unpacked"), "in the way")
    const result = await saveWith(zip())
    expect(result.file!.unpacked).toBe(join(t.folder, "pack.zip (2).unpacked"))
    expect(readFileSync(join(t.folder, "pack.zip.unpacked"), "utf8")).toBe("in the way")
  })

  test("a file that is not an archive is not unpacked", async () => {
    t.message({ name: "plain.txt", type: "" })
    t.respond(download("plain"))
    const result = await t.save(saveArgs({ unpack: true }))
    expect(result.file!.unpacked).toBeUndefined()
    expect(readdirSync(t.folder)).toEqual(["plain.txt"])
  })

  test("a hostile archive is refused before it can be unpacked", async () => {
    const result = await saveWith(buildZip([{ name: "../out.txt", data: "x" }]))
    expect(result.file).toBeUndefined()
    expect(result.refused).toBeDefined()
    expect(readdirSync(t.folder)).toEqual([])
  })
})

describe("an unpack that fails", () => {
  const boom = () => Promise.reject(new Error("disk is full"))

  test("is listed under errors.unpack:<name> with no detail it cannot vouch for, and the archive stays saved", async () => {
    t.message({ name: "pack.zip", type: "" })
    t.respond(download(zip()))
    const result = await t.save(saveArgs({ unpack: true }), { host: { unpack: boom } })
    expect(result.file).toMatchObject({ name: "pack.zip" })
    expect(result.file!.unpacked).toBeUndefined()
    expect(result.errors).toEqual({ "unpack:pack.zip": "failed" })
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
  })

  test("an error that is not ours says only its code, never a path", async () => {
    t.message({ name: "pack.zip", type: "" })
    t.respond(download(zip()))
    const enospc = () => Promise.reject(Object.assign(new Error(`ENOSPC at ${t.stateDir}`), { code: "ENOSPC" }))
    const result = await t.save(saveArgs({ unpack: true }), { host: { unpack: enospc } })
    expect(result.errors).toEqual({ "unpack:pack.zip": "failed (ENOSPC)" })
  })
})
