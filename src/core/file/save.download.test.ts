import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { ELF_BYTES } from "../archive/archive.testing"
import { ALICE } from "../chat/read.testing"
import { eventually } from "../whatsapp/sync.testing"
import { envelope, failure } from "../whatsapp/wacli.testing"
import { MESSAGE_ID, createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
})
afterEach(() => t.close())

/** The path the one download was asked to write to. */
async function askedOutput(): Promise<string> {
  const [call, ...others] = await t.downloadCalls()
  expect(others).toEqual([])
  return call!.argv[call!.argv.indexOf("--output") + 1]!
}

describe("the download", () => {
  test("is by chat and message id only, read-only beside the sync, into a file of a private folder", async () => {
    t.respond(download("data"))
    await t.save(saveArgs())

    const [call] = await t.downloadCalls()
    const output = await askedOutput()
    expect(call!.argv).toEqual([
      "--store",
      t.paths.store,
      "--json",
      "--read-only",
      "media",
      "download",
      "--chat",
      ALICE,
      "--id",
      MESSAGE_ID,
      "--output",
      output,
    ])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: t.paths.outbox })
    expect(dirname(dirname(output))).toBe(t.folder)
    expect(dirname(output)).toMatch(/\/\.[0-9a-f]{16}$/)
    expect(output.endsWith("/file")).toBe(true)
  })

  test("goes into a folder only the user can use, inside the message's own", async () => {
    t.respond(download("data", { hang: true }))
    const controller = new AbortController()
    const settled = t.save(saveArgs(), { ctx: { signal: controller.signal } }).catch((error: unknown) => error)
    await eventually(async () => (await t.downloadCalls()).length === 1)

    const staging = dirname(await askedOutput())
    expect(statSync(staging).mode & 0o777).toBe(0o700)
    expect(statSync(staging).isDirectory()).toBe(true)
    controller.abort()
    await settled
    expect(existsSync(staging)).toBe(false)
  })

  test("never puts a path or a key of the store in the result", async () => {
    t.respond(download("data"))
    const json = JSON.stringify(await t.save(saveArgs()))
    expect(json).not.toContain("private-local-path")
    expect(json).not.toContain("private-direct-path")
    expect(json).not.toContain(t.stateDir)
  })
})

describe("the folder the file is downloaded into", () => {
  const stagingOf = async () => dirname(await askedOutput())

  test("is gone after a save", async () => {
    t.respond(download("data"))
    await t.save(saveArgs())
    expect(existsSync(await stagingOf())).toBe(false)
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("is gone after a download that fails", async () => {
    t.respond(download("partial", { stderr: failure("download failed with status code 500"), exit: 1 }))
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("download failed with status code 500")
    expect(existsSync(await stagingOf())).toBe(false)
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("is gone after a file that is refused", async () => {
    t.message({ name: "cat.png", kind: "image", type: "image/png" })
    t.respond(download(ELF_BYTES))
    const result = await t.save(saveArgs())
    expect(result.refused).toBeDefined()
    expect(existsSync(await stagingOf())).toBe(false)
  })

  test("is never made for a file that is refused before the download", async () => {
    t.message({ name: "setup.exe", type: "" })
    t.respond(download("x"))
    await t.save(saveArgs())
    expect(await t.downloadCalls()).toEqual([])
    expect(existsSync(t.folder)).toBe(false)
    expect(t.siblings()).toEqual([])
  })
})

describe("a download that does not go as asked", () => {
  test("reporting another path than the one asked for is upstream_error, and nothing is saved", async () => {
    t.respond(download("data", { stdout: envelope({ path: "{output}.other" }) }))
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("did not report the file at the path")
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("reporting a download with no path is upstream_error", async () => {
    t.respond(download("data", { stdout: envelope({ bytes: 4 }) }))
    expect((await t.failure(saveArgs())).code).toBe("upstream_error")
  })

  test("reporting a file it did not leave is upstream_error, with no path in the message", async () => {
    t.respond({ args: ["media", "download"], stdout: envelope({ path: "{output}" }) })
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("no regular file")
    expect(error.message).not.toContain(t.downloadDir)
  })

  test("failing with a text that is not the server's is not asked of the phone", async () => {
    t.respond({ args: ["media", "download"], stderr: failure("message has no downloadable media metadata"), exit: 1 })
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("no downloadable media metadata")
    expect(await t.downloadCalls()).toHaveLength(1)
  })

  test("masks the numbers in wacli's text", async () => {
    t.respond({ args: ["media", "download"], stderr: failure("no media for 15550100001@s.whatsapp.net"), exit: 1 })
    const error = await t.failure(saveArgs())
    expect(error.message).not.toContain("15550100001")
  })
})
