import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError, type ErrorCode } from "../../errors"
import { CHAT_MARK_OP } from "../../whatsapp/chat-state"
import { envelope, failure } from "../../whatsapp/wacli.testing"
import { ALICE, TEAM } from "../read.testing"
import { whatsappChatMark } from "./mark"
import { chatsArgv, createStateTest, type StateTest } from "./state.testing"
import { UNCERTAIN_CHANGE } from "./state"

let t: StateTest

beforeEach(async () => {
  t = await createStateTest()
})

afterEach(async () => {
  await t.close()
})

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/
const ACCEPTED = "Accepted by WhatsApp. Only the user's own devices show this; nobody in the chat learns of it."
const NOTE_SENDERS = (n: number) =>
  `Read receipts went to the senders of ${n} ${n === 1 ? "message" : "messages"}, who may see them as read.`
const NOTE_NONE = "No unread messages needed a receipt; only the mirror's unread count changed."
const NOTE_OWN_DEVICES =
  "The user turned read receipts off, so the receipts reached only the user's own devices; no sender learns of it."
const NOTE_UNRECORDED =
  "Read receipts may have gone out, but the mirror's unread count could not be updated; errors.record says why."
const UNCERTAIN_RECEIPTS =
  "The read receipts may have gone out. Calling again is safe, but it may send them again, which only tells the senders once more that the chat was read."

/** What wacli prints for read receipts it sent. */
const receiptsSent = (data: Record<string, unknown>) =>
  envelope({ ok: true, action: "mark-read", chat: ALICE, ...data })

describe("what each mode sends through the service", () => {
  test.each([
    [{ read: false }, ["mark-unread"]],
    [{ read: true }, ["mark-read"]],
    [{ read: true, receipts: true }, ["mark-read", "--receipts"]],
  ])("%o runs wacli chats %p for the chat, without --read-only", async (args, command) => {
    await t.serve({ change: { stdout: receiptsSent({ receipts: 1, receipt: "unknown", sender_notified: null }) } })
    await t.run(whatsappChatMark, { chat: "15550100001:7@s.whatsapp.net", ...args })
    const [call, ...others] = await t.changeCalls()
    expect(others).toEqual([])
    expect(chatsArgv(call!)).toEqual(["chats", command[0]!, "--timeout", "60s", "--chat", ALICE, ...command.slice(1)])
    expect(call!.argv).not.toContain("--read-only")
  })
})

describe("the result without receipts", () => {
  test.each([true, false])(
    "names the chat, the state %p and the time, and says only the user's devices show it",
    async (read) => {
      await t.serve()
      const before = Date.now()
      const result = await t.run(whatsappChatMark, { chat: ALICE, read })
      expect(result).toEqual({ chat: ALICE, read, time: expect.stringMatching(LOCAL_TIME), note: ACCEPTED })
      expect(Date.parse(result.time)).toBeGreaterThanOrEqual(before)
      expect(Date.parse(result.time)).toBeLessThanOrEqual(Date.now())
      expect(result).not.toHaveProperty("receipts")
      expect(result).not.toHaveProperty("senders_told")
    },
  )
})

describe("the result with receipts", () => {
  const ASK = { chat: ALICE, read: true, receipts: true }

  test("says how many messages the receipts went for and that the senders may see them as read", async () => {
    await t.serve({ change: { stdout: receiptsSent({ receipts: 3, receipt: "unknown", sender_notified: null }) } })
    expect(await t.run(whatsappChatMark, ASK)).toEqual({
      chat: ALICE,
      read: true,
      receipts: 3,
      senders_told: true,
      time: expect.stringMatching(LOCAL_TIME),
      note: NOTE_SENDERS(3),
    })
  })

  test("counts one message in the singular", async () => {
    await t.serve({ change: { stdout: receiptsSent({ receipts: 1, receipt: "unknown", sender_notified: null }) } })
    expect((await t.run(whatsappChatMark, ASK)).note).toBe(NOTE_SENDERS(1))
  })

  test("says that no sender learns of it when the receipts reached only the user's own devices", async () => {
    await t.serve({ change: { stdout: receiptsSent({ receipts: 2, receipt: "read-self", sender_notified: false }) } })
    expect(await t.run(whatsappChatMark, ASK)).toMatchObject({
      receipts: 2,
      senders_told: false,
      note: NOTE_OWN_DEVICES,
    })
  })

  test("says that only the mirror's unread count changed when no message was unread", async () => {
    await t.serve({ change: { stdout: receiptsSent({ receipts: 0, local_only: true }) } })
    expect(await t.run(whatsappChatMark, { ...ASK, chat: TEAM })).toMatchObject({
      chat: TEAM,
      receipts: 0,
      senders_told: false,
      note: NOTE_NONE,
    })
  })

  test("is still the result when the receipts went out and the unread count could not be cleared, with errors.record saying why", async () => {
    await t.serve({
      change: { stderr: failure("receipts sent, but updating local unread state failed: disk full"), exit: 1 },
    })
    const result = await t.run(whatsappChatMark, ASK)
    expect(result).toEqual({
      chat: ALICE,
      read: true,
      time: expect.stringMatching(LOCAL_TIME),
      errors: { record: "receipts sent, but updating local unread state failed: disk full" },
      note: NOTE_UNRECORDED,
    })
  })
})

describe("a marking that ends in a failure", () => {
  const fails = (text: string) => ({ change: { stderr: failure(text), exit: 1 } })
  const PARTLY =
    "send read receipts to 15550100001@s.whatsapp.net (2 already sent; retry may resend them): not connected"

  test.each([
    ["without receipts", { chat: ALICE, read: true }, UNCERTAIN_CHANGE],
    ["to mark unread", { chat: ALICE, read: false }, UNCERTAIN_CHANGE],
    ["with receipts", { chat: ALICE, read: true, receipts: true }, UNCERTAIN_RECEIPTS],
  ])("%s is uncertain in its own words, saying that calling again is safe", async (_what, args, text) => {
    await t.serve(fails("delegated mark_read failed after dispatch and may still have gone through; check: deadline"))
    const error = await t.failure(whatsappChatMark, args)
    expect(error.code).toBe("uncertain")
    expect(error.message).toBe(text)
  })

  test("with some receipts already sent is uncertain, saying that a retry may send them again", async () => {
    await t.serve(fails(PARTLY))
    const error = await t.failure(whatsappChatMark, { chat: ALICE, read: true, receipts: true })
    expect(error.code).toBe("uncertain")
    expect(error.message).toBe(UNCERTAIN_RECEIPTS)
    expect(error.message).toContain("may send them again")
  })

  test("is uncertain, in the tool's words, when the sync ran the receipts and did not report them", async () => {
    await t.serve(fails("the running sync process did not report receipt results for 15550100001@s.whatsapp.net"))
    const error = await t.failure(whatsappChatMark, { chat: ALICE, read: true, receipts: true })
    expect(error.code).toBe("uncertain")
    expect(error.message).toBe(UNCERTAIN_RECEIPTS)
  })

  test("is uncertain when the service's answer cannot be read, in the words of the mode", async () => {
    const run = async () => ({ accepted_ms: "now" })
    await t.serve({ operations: { [CHAT_MARK_OP]: { kind: "delegated", writes: true, run } } })
    expect((await t.failure(whatsappChatMark, { chat: ALICE, read: true })).message).toBe(UNCERTAIN_CHANGE)
    expect((await t.failure(whatsappChatMark, { chat: ALICE, read: true, receipts: true })).message).toBe(
      UNCERTAIN_RECEIPTS,
    )
  })

  test("is uncertain when the service stops answering, and wacli is not asked again", async () => {
    await t.serve({ change: { hang: true } })
    const controller = new AbortController()
    const pending = t.failure(whatsappChatMark, { chat: ALICE, read: true, receipts: true }, controller.signal)
    await t.changedOnce()
    controller.abort()
    expect((await pending).code).toBe("uncertain")
    expect(await t.changeCalls()).toHaveLength(1)
  })

  test.each<[string, ErrorCode]>([
    ["request timed out in the send queue before dispatch; it was not sent", "upstream_error"],
    ["the running sync process does not support --receipts and left the chat unread; restart", "upstream_error"],
    ["message 3EB0A1B2C3D4E5F6 has no valid group sender; sync its history before sending receipts", "upstream_error"],
  ])("keeps its code when wacli says %p, and nothing was sent", async (text, code) => {
    await t.serve(fails(text))
    const error = await t.failure(whatsappChatMark, { chat: TEAM, read: true, receipts: true })
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe(code)
  })
})
