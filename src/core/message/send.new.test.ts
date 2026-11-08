import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { HIDDEN, TEAM } from "../chat/read.testing"
import { HELD_MIRROR, REPLY_ID, SENT_ID, createSendTest, type SendTest } from "./send.testing"

let t: SendTest

const NEW_PERSON = "15550100009@s.whatsapp.net"

beforeEach(async () => {
  t = await createSendTest()
})

afterEach(async () => {
  await t.close()
})

/** The calls the fake got for the number check. */
const checkCalls = async () => (await t.wacliCalls()).filter((call) => call.argv.includes("check"))

describe("a chat the mirror does not hold", () => {
  test.each([
    ["a hidden-number contact", HIDDEN],
    ["a group", TEAM],
    ["a phone JID whose number WhatsApp does not take", "123@s.whatsapp.net"],
  ])("is not_found for %s, and WhatsApp is not asked", async (_what, chat) => {
    await t.serve({ mirror: { chats: [], check: { "123": { registered: true } } } })
    const error = await t.failure({ chat, text: "hi" })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("whatsapp_contact_read check")
    expect(await checkCalls()).toEqual([])
    expect(await t.sendCalls()).toEqual([])
  })

  test("is sent to for a phone JID when WhatsApp says the number has an account, asked right before", async () => {
    await t.serve({ mirror: { ...HELD_MIRROR, check: { "15550100009": { registered: true, jid: NEW_PERSON } } } })
    expect(await t.run({ chat: NEW_PERSON, text: "hi" })).toMatchObject({ chat: NEW_PERSON, id: SENT_ID })

    const calls = await t.wacliCalls()
    const check = calls.findIndex((call) => call.argv.includes("check"))
    const send = calls.findIndex((call) => call.argv.includes("send"))
    expect(check).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(check)
    expect(calls[check]!.argv).toContain("+15550100009")
  })

  // WhatsApp often answers with an LID; the check then gives the number's own phone JID, which is the chat asked for.
  test("is sent to when WhatsApp answers the number with an LID", async () => {
    await t.serve({
      mirror: { ...HELD_MIRROR, check: { "15550100009": { registered: true, jid: "99887766554433@lid" } } },
    })
    expect(await t.run({ chat: NEW_PERSON, text: "hi" })).toMatchObject({ chat: NEW_PERSON, id: SENT_ID })
    const [call] = await t.sendCalls()
    expect(call!.argv[call!.argv.indexOf("--to") + 1]).toBe(NEW_PERSON)
  })

  test("is refused when WhatsApp knows the number under another phone JID, and nothing is sent", async () => {
    await t.serve({
      mirror: { ...HELD_MIRROR, check: { "15550100009": { registered: true, jid: "1555010000999@s.whatsapp.net" } } },
    })
    const error = await t.failure({ chat: NEW_PERSON, text: "hi" })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("another chat")
    expect(await t.sendCalls()).toEqual([])
  })

  test("is not_found when the number has no account, and nothing is sent", async () => {
    await t.serve({ mirror: { ...HELD_MIRROR, check: { "15550100009": { registered: false } } } })
    const error = await t.failure({ chat: NEW_PERSON, text: "hi" })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("no WhatsApp account")
    expect(await t.sendCalls()).toEqual([])
  })

  test.each([
    ["has no entry in WhatsApp's answer", {}],
    ["was not answered for", { "15550100009": { registered: true, responded: false } }],
  ])("is upstream_error when the number %s, and nothing is sent", async (_what, check) => {
    await t.serve({ mirror: { ...HELD_MIRROR, check } })
    const error = await t.failure({ chat: NEW_PERSON, text: "hi" })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("no answer")
    expect(await t.sendCalls()).toEqual([])
  })

  test("is not_found with a reply_to, since there is nothing to quote, and WhatsApp is not asked", async () => {
    await t.serve({ mirror: { ...HELD_MIRROR, check: { "15550100009": { registered: true } } } })
    const error = await t.failure({ chat: NEW_PERSON, text: "hi", reply_to: REPLY_ID })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("no message of it to reply to")
    expect(await checkCalls()).toEqual([])
    expect(await t.sendCalls()).toEqual([])
  })

  test("is upstream_error without a running service, which cannot check the number, and nothing is sent", async () => {
    t.setUp({ mirror: { ...HELD_MIRROR, check: { "15550100009": { registered: true } } } })
    const error = await t.failure({ chat: NEW_PERSON, text: "hi" })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("is not running; start it first")
    expect(error.message).toContain("whatsapp_account_read")
    expect(await t.sendCalls()).toEqual([])
  })
})
