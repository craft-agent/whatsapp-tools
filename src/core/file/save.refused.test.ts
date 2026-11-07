import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { ELF_BYTES, PE_BYTES } from "../archive/archive.testing"
import { MESSAGE_ID, createSaveFixture, download, saveArgs, type MediaInit, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
})
afterEach(() => t.close())

/** Saves a message whose file is `media` says, holding `content`. */
async function save(media: MediaInit, content: Buffer | string = "harmless text") {
  t.message(media)
  t.respond(download(content))
  return t.save(saveArgs())
}

describe("a file refused by its name or declared type", () => {
  test.each([
    ["setup.exe", undefined, "a program"],
    ["tool.msi", undefined, "an installer"],
    ["game.apk", undefined, "an app package"],
    ["budget.xlsm", undefined, "a document with macros"],
    ["thing", "application/x-msdownload", "a program"],
    ["files.7z", undefined, "cannot be inspected (7z)"],
  ])("%s (%s) is refused before anything is downloaded", async (name, type, reason) => {
    const result = await save({ name, type: type ?? "" })
    expect(result.file).toBeUndefined()
    expect(result.refused!.name).toBe(name)
    expect(result.refused!.reason).toContain(reason)
    expect(await t.downloadCalls()).toEqual([])
    expect(existsSync(t.folder)).toBe(false)
    expect(t.siblings()).toEqual([])
  })

  test("after a refusal before download, the message folder does not exist", async () => {
    const result = await save({ name: "setup.exe", type: "" })
    expect(result.refused).toBeDefined()
    expect(existsSync(t.folder)).toBe(false)
    expect(result.folder).toBe(t.folder)
  })

  test("is judged by the name it would be saved under, not the one it was sent with", async () => {
    const result = await save({ name: "setup.exe. " })
    expect(result.refused).toEqual({ name: "setup.exe", reason: "a program" })
    expect(await t.downloadCalls()).toEqual([])
  })

  test("a file with no name is judged by its type alone", async () => {
    const result = await save({ name: "", kind: "document", type: "application/x-msdownload" })
    expect(result.refused!.reason).toBe("a program")
    expect(await t.downloadCalls()).toEqual([])
  })

  test("an archive or a document name is not refused for want of bytes: it is downloaded and judged on them", async () => {
    for (const [index, name] of ["files.zip", "pack.tar.gz", "letter.docx", "data.tar"].entries()) {
      await save({ name, type: "" }, "plain text")
      expect(await t.downloadCalls()).toHaveLength(index + 1)
    }
  })

  test("source code is saved as text", async () => {
    for (const name of ["run.bat", "build.sh", "app.js"]) {
      const result = await save({ name, type: "" }, "echo hi")
      expect(result.file!.name).toBe(name)
    }
    expect(readdirSync(t.folder).sort()).toEqual(["app.js", "build.sh", "run.bat"])
  })
})

describe("a file refused by its bytes", () => {
  test.each([
    ["ELF", ELF_BYTES],
    ["PE", PE_BYTES],
  ])("%s bytes are refused under an innocent name and type, after the download", async (_label, bytes) => {
    const result = await save({ name: "cat.png", kind: "image", type: "image/png" }, bytes)
    expect(result.refused).toEqual({ name: "cat.png", reason: "a program" })
    expect(result.file).toBeUndefined()
    expect(await t.downloadCalls()).toHaveLength(1)
  })

  test("leaves nothing behind: not the saved file, not the private copy, not the downloaded one", async () => {
    await save({ name: "trojan.png", kind: "image", type: "image/png" }, ELF_BYTES)
    expect(readdirSync(t.folder)).toEqual([])
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("a file named as an archive that is not one is refused as mislabeled", async () => {
    const result = await save({ name: "files.zip", type: "" }, "plain text")
    expect(result.refused!.reason).toContain("mislabeled")
    expect(readdirSync(t.folder)).toEqual([])
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("a document named as an office file that is not a zip is refused as mislabeled", async () => {
    const result = await save({ name: "letter.docx", type: "" }, "plain text")
    expect(result.refused!.reason).toContain("mislabeled")
  })
})
