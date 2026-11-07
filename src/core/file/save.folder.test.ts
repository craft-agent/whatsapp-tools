import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ALICE } from "../chat/read.testing"
import { writeTargets } from "../targets"
import { createFileSave } from "./save"
import { MESSAGE_ID, createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
  t.respond(download("payload"))
})
afterEach(() => t.close())

describe("the download directory", () => {
  test("is required: an entry point that supplied none is an internal_error", async () => {
    const error = await t.failure(saveArgs(), { ctx: { downloadDir: undefined } })
    expect(error).toMatchObject({ code: "internal_error", message: expect.stringContaining("download directory") })
  })

  test("may not be inside the state directory, named by the setting", async () => {
    const downloadDir = join(t.stateDir, "downloads")
    const error = await t.failure(saveArgs(), { ctx: { downloadDir } })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("download_dir")
    expect(error.message).toContain("state directory")
    expect(existsSync(downloadDir)).toBe(false)
    expect(await t.downloadCalls()).toEqual([])
  })

  test("may not be the state directory, or the label's own folder or store in it", async () => {
    for (const downloadDir of [t.stateDir, t.paths.dir, t.paths.store]) {
      expect((await t.failure(saveArgs(), { ctx: { downloadDir } })).code).toBe("invalid_argument")
    }
  })

  test("may not reach the state directory through a link", async () => {
    const link = join(t.downloadDir, "link-to-state")
    symlinkSync(t.stateDir, link)
    const error = await t.failure(saveArgs(), { ctx: { downloadDir: join(link, "files") } })
    expect(error.code).toBe("invalid_argument")
    expect(readdirSync(t.stateDir)).not.toContain("files")
  })

  test("may not be inside the tools' own directory", async () => {
    const own = join(t.downloadDir, "installed")
    mkdirSync(own)
    const error = await t.failure(saveArgs(), { ctx: { ownDir: own, downloadDir: join(own, "dist", "files") } })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("download_dir")
    expect(existsSync(join(own, "dist"))).toBe(false)
  })

  test("may be a link to a folder elsewhere: its real path is what counts", async () => {
    const real = join(t.downloadDir, "real")
    mkdirSync(real)
    const link = join(t.downloadDir, "link")
    symlinkSync(real, link)
    const result = await t.save(saveArgs(), { ctx: { downloadDir: link } })
    expect(result.folder).toBe(join(real, t.paths.label, ALICE, MESSAGE_ID))
    expect(readFileSync(join(result.folder, "notes.txt"), "utf8")).toBe("payload")
  })

  test("a file where the download directory should be is invalid_argument", async () => {
    const file = join(t.downloadDir, "afile")
    writeFileSync(file, "x")
    expect((await t.failure(saveArgs(), { ctx: { downloadDir: join(file, "sub") } })).code).toBe("invalid_argument")
  })
})

describe("links below the download directory are never followed", () => {
  const chatFolder = () => join(t.downloadDir, t.paths.label, ALICE)

  test.each([
    ["the label's folder", () => join(t.downloadDir, "main"), () => t.downloadDir],
    ["the chat's folder", () => chatFolder(), () => join(t.downloadDir, "main")],
    ["the message's folder", () => t.folder, () => chatFolder()],
  ])("a link where %s belongs is refused, and nothing is written through it", async (_what, link, parent) => {
    const elsewhere = join(t.downloadDir, "elsewhere")
    mkdirSync(elsewhere)
    mkdirSync(parent(), { recursive: true })
    symlinkSync(elsewhere, link())

    const error = await t.failure(saveArgs())

    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("a link")
    expect(readdirSync(elsewhere)).toEqual([])
    expect(await t.downloadCalls()).toEqual([])
  })

  test("a file where the message's folder belongs is refused", async () => {
    mkdirSync(join(t.downloadDir, "main", ALICE), { recursive: true })
    writeFileSync(t.folder, "not a folder")
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("invalid_argument")
    expect(readFileSync(t.folder, "utf8")).toBe("not a folder")
  })

  test("a link planted at the file's name is not written through: the file is numbered", async () => {
    const victim = join(t.downloadDir, "victim.txt")
    writeFileSync(victim, "keep me")
    mkdirSync(t.folder, { recursive: true })
    symlinkSync(victim, join(t.folder, "notes.txt"))

    const result = await t.save(saveArgs())

    expect(readFileSync(victim, "utf8")).toBe("keep me")
    expect(result.file!.name).toBe("notes (2).txt")
    expect(readFileSync(join(t.folder, "notes (2).txt"), "utf8")).toBe("payload")
  })

  test("a dangling link at the file's name is not followed either", async () => {
    mkdirSync(t.folder, { recursive: true })
    const target = join(t.downloadDir, "not-there.txt")
    symlinkSync(target, join(t.folder, "notes.txt"))
    const result = await t.save(saveArgs())
    expect(existsSync(target)).toBe(false)
    expect(result.file!.name).toBe("notes (2).txt")
  })

  test("an existing folder of the right kind is reused and keeps its mode", async () => {
    mkdirSync(t.folder, { recursive: true, mode: 0o750 })
    await t.save(saveArgs())
    expect(statSync(t.folder).mode & 0o777).toBe(0o750)
  })
})

describe("what a call will write to", () => {
  const spec = createFileSave()
  const ctx = () => ({ cwd: t.stateDir, stateDir: t.stateDir, downloadDir: t.downloadDir })

  test("is the message's folder, and nothing is made to find out", async () => {
    expect(await writeTargets(spec, saveArgs(), ctx())).toEqual([t.folder])
    expect(readdirSync(t.downloadDir)).toEqual([])
  })

  test("is the same folder for the same message however it is asked for", async () => {
    expect(await writeTargets(spec, saveArgs({ unpack: true, account: t.paths.label }), ctx())).toEqual([t.folder])
    expect(await writeTargets(spec, saveArgs({ chat: `${ALICE.split("@")[0]}:7@s.whatsapp.net` }), ctx())).toEqual([
      t.folder,
    ])
  })

  test("is * when the download directory, the state directory, the label, the chat or the id cannot be told", async () => {
    expect(await writeTargets(spec, saveArgs(), { ...ctx(), downloadDir: undefined })).toEqual(["*"])
    expect(await writeTargets(spec, saveArgs(), { ...ctx(), stateDir: undefined })).toEqual(["*"])
    expect(await writeTargets(spec, saveArgs({ account: "nobody" }), ctx())).toEqual(["*"])
    expect(await writeTargets(spec, saveArgs({ id: "../nope" }), ctx())).toEqual(["*"])
    expect(await writeTargets(spec, saveArgs({ chat: "Alice" }), ctx())).toEqual(["*"])
    expect(await writeTargets(spec, { chat: ALICE }, ctx())).toEqual(["*"])
  })

  test("is * when the path holds a wildcard", async () => {
    expect(await writeTargets(spec, saveArgs(), { ...ctx(), downloadDir: join(t.downloadDir, "dl*") })).toEqual(["*"])
  })
})
