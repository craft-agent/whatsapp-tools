import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { eventually } from "../whatsapp/sync.testing"
import { envelope, failure, type FakeResponse } from "../whatsapp/wacli.testing"
import { MESSAGE_ID, createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
})
afterEach(() => t.close())

const GONE = (status = 410): FakeResponse => ({
  args: ["media", "download"],
  stderr: failure(`download failed with status code ${status}`),
  exit: 1,
})

/** The answer of the phone-bound download, which the fake tells from the plain one by `--retry-on-phone`. */
const fromPhone = (also: Partial<FakeResponse> = {}): FakeResponse => ({ args: ["--retry-on-phone"], ...also })

/** Starts the service, and then makes the fake answer: first the phone-bound download, then the plain one. */
async function serve(phone: FakeResponse, plain: FakeResponse = GONE()) {
  await t.startService()
  t.respond(phone, plain)
}

describe("a file WhatsApp's server no longer serves", () => {
  test("is asked of the phone through the sync service, and saved from there", async () => {
    await serve(fromPhone({ writeOutput: { text: "from the phone" } }))

    const result = await t.save(saveArgs())

    expect(result.file).toMatchObject({ name: "notes.txt", size: 14 })
    expect(readFileSync(join(t.folder, "notes.txt"), "utf8")).toBe("from the phone")
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("is asked for with --retry-on-phone and without --read-only, for the very file the read asked for", async () => {
    await serve(fromPhone({ writeOutput: { text: "from the phone" } }))
    await t.save(saveArgs())

    const [plain, phone, ...others] = await t.downloadCalls()
    expect(others).toEqual([])
    expect(plain!.argv).toContain("--read-only")
    expect(plain!.argv).not.toContain("--retry-on-phone")
    expect(phone!.argv).not.toContain("--read-only")
    expect(phone!.argv.at(-1)).toBe("--retry-on-phone")
    const output = (argv: string[]) => argv[argv.indexOf("--output") + 1]
    expect(output(phone!.argv)).toBe(output(plain!.argv)!)
    expect(phone!.argv.slice(phone!.argv.indexOf("media"), -1)).toEqual([
      "media",
      "download",
      "--chat",
      plain!.argv[plain!.argv.indexOf("--chat") + 1]!,
      "--id",
      MESSAGE_ID,
      "--output",
      output(plain!.argv)!,
    ])
    expect(existsSync(dirname(output(phone!.argv)!))).toBe(false)
  })

  test.each([403, 404, 410])("is asked of the phone when the server answers %d", async (status) => {
    await serve(fromPhone({ writeOutput: { text: "x" } }), GONE(status))
    expect((await t.save(saveArgs())).file).toBeDefined()
    expect(await t.downloadCalls()).toHaveLength(2)
  })

  test("is asked of the phone after a read that left part of the file, which the phone's file replaces", async () => {
    await serve(fromPhone({ writeOutput: { text: "whole" } }), {
      ...GONE(),
      writeOutput: { text: "partial and longer" },
    })
    const result = await t.save(saveArgs())
    expect(readFileSync(result.file!.path, "utf8")).toBe("whole")
  })

  test("is not taken for the phone's file when the phone writes none", async () => {
    await serve(fromPhone({ stdout: envelope({ path: "{output}", bytes: 0, source: "phone" }) }), {
      ...GONE(),
      writeOutput: { text: "left by the failed read" },
    })
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("no regular file")
    expect(readdirSync(t.folder)).toEqual([])
  })

  test("is not asked of the phone for any other failure of the download", async () => {
    await serve(fromPhone({ writeOutput: { text: "x" } }), GONE(500))
    expect((await t.failure(saveArgs())).code).toBe("upstream_error")
    expect(await t.downloadCalls()).toHaveLength(1)
  })

  test("is upstream_error when the phone's answer is not one wacli gives", async () => {
    await serve(fromPhone({ stdout: envelope({ path: "{output}" }) }))
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("cannot be read")
  })

  test("is upstream_error when the phone's file is reported elsewhere", async () => {
    await serve(
      fromPhone({ writeOutput: { text: "x" }, stdout: envelope({ path: "/elsewhere", bytes: 1, source: "phone" }) }),
    )
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("did not report the file at the path")
  })
})

describe("the phone cannot give the file", () => {
  test("it no longer has it: not_found, saying neither it nor the server has the file", async () => {
    await serve(fromPhone({ stderr: failure("media no longer available on phone"), exit: 1 }))
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("no longer has this file")
    expect(error.message).toContain("phone does not have it")
    expect(readdirSync(t.folder)).toEqual([])
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test.each(["exact media recovery failed: no answer", "media recovery request timed out"])(
    "'%s' is upstream_error saying the phone did not send it, and that asking again is safe",
    async (text) => {
      await serve(fromPhone({ stderr: failure(text), exit: 1 }))
      const error = await t.failure(saveArgs())
      expect(error.code).toBe("upstream_error")
      expect(error.message).toContain("phone did not send")
      expect(error.message).toContain("online")
      expect(error.message).toContain("Asking again is safe")
    },
  )

  test("a failure of wacli of another kind is uncertain, and saving again is safe", async () => {
    await serve(fromPhone({ stderr: failure("something odd"), exit: 1 }))
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("saving again is safe")
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("a service that stops while the phone is asked is uncertain, and saving again is safe", async () => {
    await serve(fromPhone({ hang: true }))
    const pending = t.failure(saveArgs())
    await eventually(async () => (await t.downloadCalls()).length === 2)
    await t.stopService()
    const error = await pending
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("saving again is safe")
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("a call cancelled while the phone is asked is uncertain too, and the folder it wrote in is gone", async () => {
    await serve(fromPhone({ hang: true }))
    const controller = new AbortController()
    const pending = t.failure(saveArgs(), { ctx: { signal: controller.signal } })
    await eventually(async () => (await t.downloadCalls()).length === 2)
    controller.abort()
    const error = await pending
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("saving again is safe")
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })
})

describe("the sync service is not running", () => {
  test("is upstream_error saying the file expired and that asking the phone needs the service", async () => {
    t.respond(GONE())
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("no longer on WhatsApp's server")
    expect(error.message).toContain("sync service running")
    expect(error.message).toContain("whatsapp_account_read")
    expect(error.message).toContain("is not running")
    expect(await t.downloadCalls()).toHaveLength(1)
    expect(readdirSync(t.folder)).toEqual([])
    expect(t.siblings()).toEqual([MESSAGE_ID])
  })

  test("is not in the way of a file the server still serves", async () => {
    t.respond(download("served"))
    expect((await t.save(saveArgs())).file).toBeDefined()
    expect(statSync(t.folder).isDirectory()).toBe(true)
  })
})
