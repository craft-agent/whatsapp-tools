import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { ToolError, type ErrorCode } from "../errors"
import { CHAT_MARK_OP, CHAT_STATE_DEADLINE_MS, chatMarkAnswer } from "./chat-state"
import { serviceOperations } from "./operations"
import { callService } from "./service-client"
import { DOCTOR_OK, HANGING_SYNC, startService, syncFixture, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope, failure, type FakeResponse } from "./wacli.testing"

const CHAT = "15550100001@s.whatsapp.net"
const GROUP = "120363000000000001@g.us"

let fixture: SyncFixture
let service: Awaited<ReturnType<typeof startService>> | undefined

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  service = await startService(fixture, serviceOperations())
})

afterEach(async () => {
  service?.stop()
  await service?.outcome
  service = undefined
  await fixture.cleanup()
})

/** Has the fake answer `chats mark-read` and `chats mark-unread` as `response` says. */
function answerMark(response: Omit<FakeResponse, "args">): void {
  fixture.fake.setResponses([
    DOCTOR_OK,
    HANGING_SYNC,
    { args: ["chats", "mark-read"], ...response },
    { args: ["chats", "mark-unread"], ...response },
  ])
}

const markedEnvelope = (data: Record<string, unknown> = {}) =>
  envelope({ ok: true, action: "mark-read", chat: CHAT, ...data })

const ask = (args: unknown, timeoutMs = CHAT_STATE_DEADLINE_MS) =>
  callService(fixture.paths, CHAT_MARK_OP, args, { mode: "write", timeoutMs }).catch((error: unknown) => {
    if (error instanceof ToolError) return error
    throw error
  })

const markCalls = async () =>
  (await fixture.fake.calls()).filter((call) => call.argv.some((a) => a.startsWith("mark-")))

describe("the chat_mark operation", () => {
  test("is a delegated one that writes, so that a stop or a deadline during it is uncertain", () => {
    expect(serviceOperations()[CHAT_MARK_OP]).toMatchObject({ kind: "delegated", writes: true })
  })

  test.each([
    ["marks unread", { read: false }, ["mark-unread"]],
    ["marks read, which tells no one", { read: true }, ["mark-read"]],
    ["marks read with the read receipts asked for", { read: true, receipts: true }, ["mark-read", "--receipts"]],
    ["marks read with the receipts explicitly left out", { read: true, receipts: false }, ["mark-read"]],
  ])("%s: runs wacli chats %p without --read-only, with its own time-out", async (_what, args, command) => {
    answerMark({ stdout: markedEnvelope({ receipts: 1, receipt: "unknown", sender_notified: null }) })
    await ask({ chat: CHAT, ...args })
    const [call, ...others] = await markCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual([
      "--store",
      fixture.paths.store,
      "--json",
      "chats",
      command[0]!,
      "--timeout",
      "60s",
      "--chat",
      CHAT,
      ...command.slice(1),
    ])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test.each([
    ["receipts without read", { chat: CHAT, read: false, receipts: true }],
    ["a missing read", { chat: CHAT }],
    ["a read that is not a boolean", { chat: CHAT, read: "yes" }],
    ["a receipts that is not a boolean", { chat: CHAT, read: true, receipts: 1 }],
    ["a chat that is not a JID", { chat: "Alice", read: true }],
    ["a channel", { chat: "120363000000000002@newsletter", read: true }],
    ["a missing chat", { read: true }],
    ["an argument it does not know", { chat: CHAT, read: true, through: "3EB0A1B2C3D4E5F6" }],
  ])("refuses %s as invalid_argument, and runs nothing", async (_what, args) => {
    answerMark({ stdout: markedEnvelope() })
    const error = await ask(args)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await markCalls()).toEqual([])
  })

  test("is uncertain when the deadline passes while wacli has not answered, and wacli is stopped", async () => {
    answerMark({ hang: true })
    const error = await ask({ chat: CHAT, read: true, receipts: true }, 3000)
    expect((error as ToolError).code).toBe("uncertain")
    expect(await markCalls()).toHaveLength(1)
  })
})

describe("what the operation answers", () => {
  test.each([
    ["marking unread", { read: false }, { action: "mark-unread" }],
    ["marking read", { read: true }, {}],
  ])("is only when it was accepted for %s", async (_what, args, data) => {
    answerMark({ stdout: markedEnvelope(data) })
    const before = Date.now()
    const answer = chatMarkAnswer.parse(await ask({ chat: CHAT, ...args }))
    expect(answer.accepted_ms).toBeGreaterThanOrEqual(before)
    expect(answer.accepted_ms).toBeLessThanOrEqual(Date.now())
    expect(Object.keys(answer)).toEqual(["accepted_ms"])
  })

  test.each([
    [
      "receipts that tell the senders (wacli says unknown, since whatsmeow may downgrade them)",
      3,
      "unknown",
      null,
      true,
    ],
    ["receipts of a type that is read", 1, "read", null, true],
    ["receipts only the user's own devices see (read-self)", 2, "read-self", false, false],
  ])("says for %s whether the senders are told", async (_what, receipts, receipt, notified, told) => {
    answerMark({ stdout: markedEnvelope({ receipts, receipt, sender_notified: notified }) })
    expect(await ask({ chat: GROUP, read: true, receipts: true })).toEqual({
      accepted_ms: expect.any(Number),
      receipts,
      senders_told: told,
    })
  })

  test("says that no one is told when there was nothing to acknowledge, and only the local state changed", async () => {
    answerMark({ stdout: markedEnvelope({ receipts: 0, local_only: true }) })
    expect(await ask({ chat: CHAT, read: true, receipts: true })).toEqual({
      accepted_ms: expect.any(Number),
      receipts: 0,
      senders_told: false,
    })
  })

  test("is a success carrying wacli's warning when the receipts went out and the unread count could not be cleared", async () => {
    answerMark({
      stderr: failure("receipts sent, but updating local unread state failed: disk full for 15550100001"),
      exit: 1,
    })
    const answer = await ask({ chat: CHAT, read: true, receipts: true })
    expect(answer).toEqual({
      accepted_ms: expect.any(Number),
      store_warning: "receipts sent, but updating local unread state failed: disk full for <number>",
    })
  })

  test("is uncertain when wacli reports success for receipts without saying how many", async () => {
    answerMark({ stdout: markedEnvelope() })
    expect(((await ask({ chat: CHAT, read: true, receipts: true })) as ToolError).code).toBe("uncertain")
  })
})

describe("what wacli says when marking fails", () => {
  const fails = (text: string) => answerMark({ stderr: failure(text), exit: 1 })
  const asked = (receipts = true) => ask({ chat: GROUP, read: true, receipts }) as Promise<ToolError>

  test.each<[string, ErrorCode]>([
    ["--chat is required", "invalid_argument"],
    ["request timed out in the send queue before dispatch; it was not sent", "upstream_error"],
    ["send spacing exceeded request timeout before dispatch; it was not sent", "upstream_error"],
    [
      "the running sync process does not support --receipts and left the chat unread; restart `wacli sync`",
      "upstream_error",
    ],
    ["read-only mode: chats mark-read is refused", "invalid_argument"],
    ["not authenticated; run `wacli auth`", "unauthenticated"],
  ])("%s is %s", async (text, code) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("120363000000000001")
  })

  test("names the change when the queue dropped it, and says trying again is safe", async () => {
    fails("request timed out in the send queue before dispatch; it was not sent")
    const message = (await asked()).message
    expect(message).toStartWith("WhatsApp did not get the change:")
    expect(message).toEndWith("Nothing was changed; trying again is safe.")
  })

  test("tells the sync to be restarted after wacli is upgraded when it does not take receipts", async () => {
    fails("the running sync process does not support --receipts and left the chat unread; restart `wacli sync`")
    const message = (await asked()).message
    expect(message).toContain("Update wacli and restart the sync service")
    expect(message).toContain("Nothing was changed")
  })

  test.each([
    ["message 3EB0A1B2C3D4E5F6 has no valid group sender; sync its history before sending receipts"],
    ["group addressing mode unavailable"],
    ["load group addressing mode: info query timed out"],
    ["select unread messages for 120363000000000001@g.us: database is locked"],
    ["stored message has no ID"],
  ])("%p is upstream_error, said before any receipt was sent, and nothing was sent or changed", async (text) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toStartWith("wacli could not prepare the read receipts (")
    expect(error.message).toEndWith("Nothing was sent or changed; trying again is safe.")
    expect(error.message).not.toContain("120363000000000001")
  })

  test("is uncertain when the sync ran the receipts and did not report them, since they may have gone out", async () => {
    fails("the running sync process did not report receipt results for 120363000000000001@g.us; restart `wacli sync`")
    const error = await asked()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("they may have gone out")
    expect(error.message).toContain("Calling again may send them again")
    expect(error.message).not.toContain("120363000000000001")
  })

  test("is uncertain when some receipts went out before a later batch failed, saying they may go out again", async () => {
    fails("send read receipts to 15550100001@s.whatsapp.net (2 already sent; retry may resend them): not connected")
    const error = await asked()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("some may have gone out")
    expect(error.message).toContain("send them again")
    expect(error.message).not.toContain("15550100001")
  })

  test.each([
    [
      "delegated mark_read_receipts failed after dispatch and may still have gone through; check before retrying: deadline",
    ],
    ["no reply from the running sync process before the timeout; the change may still have gone through"],
    ["wait for missing WhatsApp app state key during regular_low recovery: context deadline exceeded"],
    ["send read receipts to 15550100001@s.whatsapp.net (0 already sent; retry may resend them): not connected"],
    ["connection lost; reconnect failed: dial tcp: i/o timeout"],
    ["something wacli has never said"],
    [""],
  ])("%p is uncertain", async (text) => {
    fails(text)
    expect((await asked()).code).toBe("uncertain")
    expect((await asked(false)).code).toBe("uncertain")
  })

  test("is uncertain when wacli exits 1 without a result, or ends with output that is no result", async () => {
    answerMark({ stderr: "panic: runtime error\n", exit: 1 })
    expect((await asked()).code).toBe("uncertain")
    answerMark({ stdout: "mark-read: 1555\n", exit: 2 })
    expect((await asked()).code).toBe("uncertain")
    answerMark({ stdout: "mark-read\n" })
    expect((await asked()).code).toBe("uncertain")
  })

  test.each([
    ["ok: false", { ok: false, action: "mark-read", chat: CHAT }],
    ["no ok", { action: "mark-read", chat: CHAT }],
    ["no data", null],
  ])("is uncertain when wacli reports success with %s", async (_what, data) => {
    answerMark({ stdout: envelope(data) })
    expect((await asked(false)).code).toBe("uncertain")
  })
})
