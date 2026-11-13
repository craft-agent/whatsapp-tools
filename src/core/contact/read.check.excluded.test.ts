import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { serviceOperations } from "../whatsapp/operations"
import { startService, syncFixture, type SyncFixture } from "../whatsapp/sync.testing"
import { resetWacliCache } from "../whatsapp/wacli"
import { readContacts } from "./read.testing"

let fixture: SyncFixture
let service: Awaited<ReturnType<typeof startService>> | undefined

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  service = await startService(fixture, serviceOperations())
  fixture.fake.setMirror({
    check: {
      "15550100001": { registered: true, jid: "15550100001@s.whatsapp.net" },
      "15550100002": { registered: true },
      "15550100003": { registered: false },
      "15550100004": { registered: true, responded: false },
    },
  })
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

const check = (excluded?: string[]) =>
  readContacts(fixture.stateDir, { method: "check", numbers: [A, B, C, D] }, excluded)

describe("number check with excluded chats", () => {
  test("reports a number whose chat is excluded as unknown, exactly as an unanswered number, and keeps the rest", async () => {
    const result = await check(["15550100002@s.whatsapp.net"])
    expect(result.numbers).toEqual([
      { number: A, status: "on_whatsapp", chat: "15550100001@s.whatsapp.net" },
      { number: B, status: "unknown" },
      { number: C, status: "not_on_whatsapp" },
      { number: D, status: "unknown" },
    ])
    expect(Object.keys(result.numbers![1]!)).toEqual(Object.keys(result.numbers![3]!))
  })

  test("is unchanged without the setting", async () => {
    expect((await check()).numbers?.map((entry) => entry.status)).toEqual([
      "on_whatsapp",
      "on_whatsapp",
      "not_on_whatsapp",
      "unknown",
    ])
  })

  test("hides the person whose number WhatsApp answers with the …@lid, whose chat is the phone JID", async () => {
    fixture.fake.setMirror({ check: { "15550100001": { registered: true, jid: "99887766554433@lid" } } })
    const result = await readContacts(fixture.stateDir, { method: "check", numbers: [A] }, [
      "15550100001@s.whatsapp.net",
    ])
    expect(result.numbers).toEqual([{ number: A, status: "unknown" }])
  })

  test("leaves a number whose chat is not excluded alone when only its other JID is", async () => {
    const result = await readContacts(fixture.stateDir, { method: "check", numbers: [A] }, ["99887766554433@lid"])
    expect(result.numbers).toEqual([{ number: A, status: "on_whatsapp", chat: "15550100001@s.whatsapp.net" }])
  })
})
