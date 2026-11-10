import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { labelPaths } from "./labels"
import { linkedJid } from "./linked-jid"
import { shortTempDir } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope, failure, installFakeWacli, type FakeWacli } from "./wacli.testing"

let stateDir: string
let fake: FakeWacli
let originalPath: string | undefined

beforeEach(async () => {
  stateDir = await shortTempDir()
  fake = await installFakeWacli()
  originalPath = process.env.PATH
  process.env.PATH = fake.env.PATH
  resetWacliCache()
})

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  resetWacliCache()
  await fake.cleanup()
  rmSync(stateDir, { recursive: true, force: true })
})

const paths = () => labelPaths(stateDir, "main")

const reportsLinked = (linked: unknown) =>
  fake.setResponses([{ args: ["doctor"], stdout: envelope({ authenticated: true, linked_jid: linked }) }])

describe("the JID of the linked account", () => {
  test("is the one wacli reports, without the device it names", async () => {
    reportsLinked("15550100000:4@s.whatsapp.net")
    expect(await linkedJid(paths(), undefined)).toBe("15550100000@s.whatsapp.net")
    reportsLinked("15550100000@s.whatsapp.net")
    expect(await linkedJid(paths(), undefined)).toBe("15550100000@s.whatsapp.net")
  })

  test("is asked of wacli's doctor with --read-only, on the label's store", async () => {
    reportsLinked("15550100000@s.whatsapp.net")
    await linkedJid(paths(), undefined)
    const [call] = (await fake.calls()).filter((entry) => entry.argv.includes("doctor"))
    expect(call!.argv).toEqual(["--store", paths().store, "--json", "--read-only", "doctor"])
  })

  test.each([
    ["absent", undefined],
    ["empty", ""],
    ["not a text", 5],
    ["not a JID", "not a jid"],
  ])("is undefined when wacli's report has a linked_jid that is %s", async (_what, linked) => {
    reportsLinked(linked)
    expect(await linkedJid(paths(), undefined)).toBeUndefined()
  })

  test("is undefined when wacli's report is not an object, or wacli fails", async () => {
    fake.setResponses([{ args: ["doctor"], stdout: envelope(["x"]) }])
    expect(await linkedJid(paths(), undefined)).toBeUndefined()
    fake.setResponses([{ args: ["doctor"], stderr: failure("store is locked"), exit: 1 }])
    expect(await linkedJid(paths(), undefined)).toBeUndefined()
    fake.setResponses([{ args: ["doctor"], stdout: "not json\n" }])
    expect(await linkedJid(paths(), undefined)).toBeUndefined()
  })

  test("rejects with the abort when the call is aborted", async () => {
    reportsLinked("15550100000@s.whatsapp.net")
    const controller = new AbortController()
    controller.abort()
    await expect(linkedJid(paths(), controller.signal)).rejects.toThrow()
  })
})
