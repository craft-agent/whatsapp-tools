import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ALICE } from "../chat/read.testing"
import { MESSAGE_ID, createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
})
afterEach(() => t.close())

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex")
const mode = (path: string) => statSync(path).mode & 0o777

/** Makes the message's folder, as an earlier call or the user would have. */
function mkdirFolder(): void {
  mkdirSync(t.folder, { recursive: true, mode: 0o700 })
}

describe("saving a message's file", () => {
  test("saves a plain file, private and not executable, with its content, type and SHA-256", async () => {
    t.respond(download("hello, files"))

    const result = await t.save(saveArgs())

    const path = join(t.folder, "notes.txt")
    expect(result.chat).toBe(ALICE)
    expect(result.id).toBe(MESSAGE_ID)
    expect(result.folder).toBe(t.folder)
    expect(result.file).toEqual({
      name: "notes.txt",
      path,
      type: "text/plain",
      size: 12,
      sha256: sha256("hello, files"),
    })
    expect(result.refused).toBeUndefined()
    expect(result.errors).toBeUndefined()
    expect(result.note).toContain("never executable")
    expect(readFileSync(path, "utf8")).toBe("hello, files")
    expect(mode(path)).toBe(0o600)
    expect(mode(t.folder)).toBe(0o700)
    expect(mode(join(t.downloadDir, t.paths.label))).toBe(0o700)
    expect(mode(join(t.downloadDir, t.paths.label, ALICE))).toBe(0o700)
    expect(readdirSync(t.folder)).toEqual(["notes.txt"])
  })

  test("makes a download directory that does not exist yet, folder by folder, all private", async () => {
    t.respond(download("x"))
    const downloadDir = join(t.downloadDir, "new", "deeper")

    const result = await t.save(saveArgs(), { ctx: { downloadDir } })

    expect(result.folder).toBe(join(downloadDir, t.paths.label, ALICE, MESSAGE_ID))
    expect(mode(join(t.downloadDir, "new"))).toBe(0o700)
    expect(mode(downloadDir)).toBe(0o700)
  })

  test("saves a binary file byte for byte", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 128])
    t.message({ kind: "image", name: "dot.png", type: "image/png" })
    t.respond(download(bytes))
    const result = await t.save(saveArgs())
    expect(result.file).toMatchObject({ name: "dot.png", type: "image/png", size: 7, sha256: sha256(bytes) })
    expect([...readFileSync(result.file!.path)]).toEqual([...bytes])
  })

  test("saves an empty file", async () => {
    t.respond(download(""))
    const result = await t.save(saveArgs())
    expect(result.file).toMatchObject({ name: "notes.txt", size: 0, sha256: sha256("") })
  })

  test("leaves nothing but the file in the folder and nothing but the folder beside it, and shows no store path", async () => {
    t.respond(download("data"))
    const result = await t.save(saveArgs())
    expect(readdirSync(t.folder)).toEqual(["notes.txt"])
    expect(t.siblings()).toEqual([MESSAGE_ID])
    expect(JSON.stringify(result)).not.toContain(t.stateDir)
  })
})

describe("saving the same message again", () => {
  test("downloads again and reuses the file that is saved", async () => {
    t.respond(download("same bytes"))
    const first = await t.save(saveArgs())
    const second = await t.save(saveArgs())
    expect(first.file!.already_saved).toBeUndefined()
    expect(second.file).toEqual({ ...first.file!, already_saved: true })
    expect(readdirSync(t.folder)).toEqual(["notes.txt"])
    expect(await t.downloadCalls()).toHaveLength(2)
  })

  test("a different file already under the name is never overwritten: the new one is numbered", async () => {
    t.respond(download("from the sender"))
    mkdirFolder()
    writeFileSync(join(t.folder, "notes.txt"), "the user's own", { mode: 0o644 })

    const result = await t.save(saveArgs())

    expect(result.file!.name).toBe("notes (2).txt")
    expect(readFileSync(join(t.folder, "notes.txt"), "utf8")).toBe("the user's own")
    expect(mode(join(t.folder, "notes.txt"))).toBe(0o644)
    expect(readFileSync(join(t.folder, "notes (2).txt"), "utf8")).toBe("from the sender")
    const again = await t.save(saveArgs())
    expect(again.file).toMatchObject({ name: "notes (2).txt", already_saved: true })
  })

  test.each([0o755, 0o644, 0o666, 0o700, 0o400])(
    "the same bytes at mode %o are not a file this tool made: left untouched, a fresh 0600 copy is numbered",
    async (existingMode) => {
      t.respond(download("identical bytes"))
      mkdirFolder()
      const existing = join(t.folder, "notes.txt")
      writeFileSync(existing, "identical bytes")
      chmodSync(existing, existingMode)

      const result = await t.save(saveArgs())

      expect(result.file).toMatchObject({ name: "notes (2).txt" })
      expect(result.file!.already_saved).toBeUndefined()
      expect(mode(existing)).toBe(existingMode)
      expect(mode(join(t.folder, "notes (2).txt"))).toBe(0o600)
      const again = await t.save(saveArgs())
      expect(again.file).toMatchObject({ name: "notes (2).txt", already_saved: true })
      expect(mode(existing)).toBe(existingMode)
    },
  )

  test("a file with the same bytes that is exactly what the tool makes is reused", async () => {
    t.respond(download("identical bytes"))
    mkdirFolder()
    writeFileSync(join(t.folder, "notes.txt"), "identical bytes", { mode: 0o600 })
    chmodSync(join(t.folder, "notes.txt"), 0o600)
    expect((await t.save(saveArgs())).file).toMatchObject({ name: "notes.txt", already_saved: true })
  })

  test("a file that is the same size but not the same bytes is not taken for the saved one", async () => {
    t.respond(download("aaaa"))
    mkdirFolder()
    writeFileSync(join(t.folder, "notes.txt"), "bbbb")
    expect((await t.save(saveArgs())).file!.name).toBe("notes (2).txt")
  })
})
