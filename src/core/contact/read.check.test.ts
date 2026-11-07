import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { serviceOperations } from "../whatsapp/operations"
import {
  DOCTOR_OK,
  HANGING_SYNC,
  eventually,
  startService,
  syncFixture,
  type SyncFixture,
} from "../whatsapp/sync.testing"
import { resetWacliCache } from "../whatsapp/wacli"
import { envelope, failure, type FakeMirror } from "../whatsapp/wacli.testing"
import { failureOf, readContacts } from "./read.testing"

let fixture: SyncFixture
let service: Awaited<ReturnType<typeof startService>> | undefined

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
})

afterEach(async () => {
  service?.stop()
  await service?.outcome
  service = undefined
  await fixture.cleanup()
})

const A = "+15550100001"
const B = "+15550100002"
const C = "+15550100003"
const D = "+15550100004"

/** Starts the service with the operations the CLI gives it and the fake answering `check` as WhatsApp would. */
async function serve(check: NonNullable<FakeMirror["check"]>) {
  service = await startService(fixture, serviceOperations())
  fixture.fake.setMirror({ check })
}

const checkNumbers = (numbers: string[]) => readContacts(fixture.stateDir, { method: "check", numbers })

/** The calls the fake got for the number check. */
const checkCalls = async () => (await fixture.fake.calls()).filter((call) => call.argv.includes("contacts"))

describe("check through the sync service", () => {
  test("says on_whatsapp with the JID to write to, not_on_whatsapp, and unknown for what WhatsApp left out", async () => {
    await serve({
      "15550100001": { registered: true, jid: "15550100001@s.whatsapp.net" },
      "15550100002": { registered: false },
      "15550100003": { registered: true, responded: false },
    })
    const result = await checkNumbers([A, B, C, D])
    expect(result.numbers).toEqual([
      { number: A, status: "on_whatsapp", chat: "15550100001@s.whatsapp.net" },
      { number: B, status: "not_on_whatsapp" },
      { number: C, status: "unknown" },
      { number: D, status: "unknown" },
    ])
    expect(result.note).toContain("unknown means WhatsApp gave no answer")
    expect(result.note).toContain("not saved among the contacts")
  })

  test("gives the JID wacli names even when it differs from the number typed, else one made of the digits", async () => {
    await serve({
      "15550100001": { registered: true, jid: "1555010000199@s.whatsapp.net" },
      "15550100002": { registered: true },
    })
    const result = await checkNumbers([A, B])
    expect(result.numbers?.map((entry) => entry.chat)).toEqual([
      "1555010000199@s.whatsapp.net",
      "15550100002@s.whatsapp.net",
    ])
  })

  test("normalises the numbers and asks once about duplicates, in the order given", async () => {
    await serve({ "15550100001": { registered: true }, "15550100002": { registered: false } })
    const result = await checkNumbers(["+1 (555) 010-0002", "+1.555.010.0001", B, A])
    expect(result.numbers?.map((entry) => [entry.number, entry.status])).toEqual([
      [B, "not_on_whatsapp"],
      [A, "on_whatsapp"],
    ])
    expect((await checkCalls()).map((call) => call.argv.slice(call.argv.indexOf("contacts")))).toEqual([
      ["contacts", "check", "--", B, A],
    ])
  })

  test("is run by the service, with wacli's check allowed to ask WhatsApp: no --read-only", async () => {
    await serve({ "15550100001": { registered: true } })
    await checkNumbers([A])
    const [call, ...others] = await checkCalls()
    expect(others).toEqual([])
    expect(call?.argv).not.toContain("--read-only")
    expect(call?.argv.slice(0, 3)).toEqual(["--store", fixture.paths.store, "--json"])
    expect(call?.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test("is upstream_error, with wacli's text, when wacli fails: a check is not a write, so never uncertain", async () => {
    service = await startService(fixture, serviceOperations())
    fixture.fake.setResponses([
      DOCTOR_OK,
      HANGING_SYNC,
      { args: ["contacts", "check"], stderr: failure("usync query failed"), exit: 1 },
    ])
    const error = await failureOf(fixture.stateDir, { method: "check", numbers: [A] })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("usync query failed")
  })

  test("is upstream_error when wacli's answer cannot be read", async () => {
    service = await startService(fixture, serviceOperations())
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["contacts", "check"], stdout: envelope({ nope: 1 }) }])
    const error = await failureOf(fixture.stateDir, { method: "check", numbers: [A] })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("cannot be read")
  })

  test("is upstream_error, not uncertain, when the service stops before WhatsApp answered", async () => {
    service = await startService(fixture, serviceOperations())
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["contacts", "check"], hang: true }])
    const pending = failureOf(fixture.stateDir, { method: "check", numbers: [A] })
    await eventually(async () => (await checkCalls()).length === 1)
    service.stop()
    const error = await pending
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("nothing was changed")
  })
})

describe("check without the sync service", () => {
  test("is upstream_error saying to start it, and the tool runs no wacli of its own", async () => {
    fixture.fake.setMirror({ check: { "15550100001": { registered: true } } })
    const error = await failureOf(fixture.stateDir, { method: "check", numbers: [A] })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("start it first")
    expect(await checkCalls()).toEqual([])
    expect((await fixture.fake.calls()).filter((call) => call.argv[0] !== "version")).toEqual([])
  })
})
