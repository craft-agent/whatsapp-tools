import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { ToolError, type ErrorCode } from "../errors"
import { serviceOperations } from "./operations"
import { MESSAGE_SEND_DEADLINE_MS, MESSAGE_SEND_OP, MESSAGE_TEXT_MAX_CHARACTERS } from "./send"
import { callService } from "./service-client"
import { DOCTOR_OK, HANGING_SYNC, startService, syncFixture, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope, failure, type FakeResponse } from "./wacli.testing"

const CHAT = "15550100001@s.whatsapp.net"
const ID = "3EB0A1B2C3D4E5F6"
const REPLY_TO = "3EB0F6E5D4C3B2A1"
const TEXT = "Running late, start without me"

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

/** Has the fake answer the send as `response` says. */
function answerSend(response: Omit<FakeResponse, "args">): void {
  fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["send", "text"], ...response }])
}

const sentEnvelope = (data: Record<string, unknown> = {}) => envelope({ sent: true, to: CHAT, id: ID, ...data })

const ask = (args: unknown, timeoutMs = MESSAGE_SEND_DEADLINE_MS) =>
  callService(fixture.paths, MESSAGE_SEND_OP, args, { mode: "write", timeoutMs }).catch((error: unknown) => {
    if (error instanceof ToolError) return error
    throw error
  })

const sendCalls = async () => (await fixture.fake.calls()).filter((call) => call.argv.includes("send"))

describe("the message_send operation", () => {
  test("is a delegated one that writes, so that a stop or a deadline during it is uncertain", () => {
    expect(serviceOperations()[MESSAGE_SEND_OP]).toMatchObject({ kind: "delegated", writes: true })
  })

  test("answers with the id wacli reports and when it did, and tells what wacli says of writing the mirror", async () => {
    answerSend({ stdout: sentEnvelope() })
    const before = Date.now()
    const answer = (await ask({ chat: CHAT, text: TEXT })) as { id: string; accepted_ms: number }
    expect(answer.id).toBe(ID)
    expect(answer.accepted_ms).toBeGreaterThanOrEqual(before)
    expect(answer.accepted_ms).toBeLessThanOrEqual(Date.now())
    expect(answer).not.toHaveProperty("store_warning")

    answerSend({ stdout: sentEnvelope({ store_warning: "message update: disk full for 15550100001" }) })
    expect(await ask({ chat: CHAT, text: TEXT })).toMatchObject({
      id: ID,
      store_warning: "message update: disk full for <number>",
    })
  })

  test("runs wacli without --read-only, with --no-preview and its own time-out, and the text as one argument", async () => {
    answerSend({ stdout: sentEnvelope() })
    const text = "--help -x\nline two ✓"
    await ask({ chat: CHAT, text })
    const [call, ...others] = await sendCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual([
      "--store",
      fixture.paths.store,
      "--json",
      "send",
      "text",
      "--timeout",
      "60s",
      "--to",
      CHAT,
      "--message",
      text,
      "--no-preview",
    ])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test("quotes the message reply_to names", async () => {
    answerSend({ stdout: sentEnvelope() })
    await ask({ chat: CHAT, text: TEXT, reply_to: REPLY_TO })
    const [call] = await sendCalls()
    expect(call!.argv.slice(-3)).toEqual(["--no-preview", "--reply-to", REPLY_TO])
  })

  test("takes 4000 characters counted as code points and refuses 4001", async () => {
    answerSend({ stdout: sentEnvelope() })
    expect(await ask({ chat: CHAT, text: "😀".repeat(MESSAGE_TEXT_MAX_CHARACTERS) })).toMatchObject({ id: ID })
    const error = await ask({ chat: CHAT, text: "😀".repeat(MESSAGE_TEXT_MAX_CHARACTERS + 1) })
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await sendCalls()).toHaveLength(1)
  })

  test.each([
    ["a chat that is not a JID", { chat: "Alice" }],
    ["a missing chat", { chat: undefined }],
    ["an empty text", { text: "" }],
    ["a text that is not text", { text: 5 }],
    ["a reply_to that is not a message id", { reply_to: "-x" }],
    ["an argument it does not know", { preview: true }],
  ])("refuses %s as invalid_argument, and runs nothing", async (_what, change) => {
    answerSend({ stdout: sentEnvelope() })
    const error = await ask({ chat: CHAT, text: TEXT, ...change })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await sendCalls()).toEqual([])
  })

  test("is uncertain when the deadline passes while wacli has not answered, and wacli is stopped", async () => {
    answerSend({ hang: true })
    const error = await ask({ chat: CHAT, text: TEXT }, 3000)
    expect((error as ToolError).code).toBe("uncertain")
    expect(await sendCalls()).toHaveLength(1)
  })
})

describe("what wacli says when the send fails", () => {
  const fails = (text: string) => answerSend({ stderr: failure(text), exit: 1 })
  const asked = () => ask({ chat: CHAT, text: TEXT, reply_to: REPLY_TO }) as Promise<ToolError>

  test.each<[string, ErrorCode]>([
    ["request timed out in the send queue before dispatch; it was not sent", "upstream_error"],
    ["send spacing exceeded request timeout before dispatch; it was not sent", "upstream_error"],
    [
      "send text to the linked account itself is not supported: use the official Message Yourself chat",
      "invalid_argument",
    ],
    [`quoted message ${REPLY_TO} not found in local store for chat ${CHAT}; run \`wacli sync\` first`, "not_found"],
    ["--reply-to-sender is required because the stored group message has no sender", "invalid_argument"],
    ["invalid --reply-to-sender: not a JID", "invalid_argument"],
    ["stored quoted sender is invalid: bad JID", "invalid_argument"],
    [`linked account JID is unavailable for quoted outgoing message ${REPLY_TO}`, "invalid_argument"],
    [`linked account LID is unavailable for quoted outgoing message ${REPLY_TO}`, "invalid_argument"],
    ["get group info for quoted outgoing message: not connected", "upstream_error"],
    [`cannot quote message ${REPLY_TO}: stored message was deleted`, "invalid_argument"],
    [
      `cannot quote message ${REPLY_TO}: stored message content is not supported for quoted replies`,
      "invalid_argument",
    ],
    ["lookup quoted message: database is closed", "upstream_error"],
    ["--to and --message are required", "invalid_argument"],
    ["read-only mode: send is refused", "invalid_argument"],
    ["not authenticated; run `wacli auth`", "unauthenticated"],
    ["store is locked (another wacli is running?): locked", "upstream_error"],
    ["WhatsApp session was revoked: unknown", "unauthenticated"],
    ["WhatsApp login failed: banned", "unauthenticated"],
  ])("%s is %s, and nothing was sent", async (text, code) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("15550100001")
  })

  test.each([
    [
      "delegated text failed after dispatch and may still have gone through; check before retrying: context deadline exceeded",
    ],
    [
      "no reply from the running sync process before the timeout; the text may still have gone through, so check before retrying",
    ],
    ["request timed out in the send queue before dispatch; it was not sent, and it may still have gone through"],
    ["quoted message 3EB0 not found in local store for chat x; the text may still have gone through"],
    ["not authenticated, though it may still have gone through"],
    ["send text to the linked account itself is not supported: it may still have gone through"],
    ["send timed out after 45s"],
    ["connection lost; reconnect failed: dial tcp: i/o timeout"],
    ["usync query failed; reconnect failed: not authenticated; run `wacli auth`"],
    ["send failed: store is locked (another wacli is running?)"],
    ["something wacli has never said"],
    [""],
  ])("%p is uncertain", async (text) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })

  test("is uncertain when wacli exits 1 without a result, or ends on a signal", async () => {
    answerSend({ stderr: "panic: runtime error\n", exit: 1 })
    expect((await asked()).code).toBe("uncertain")
    answerSend({ stdout: "not json\n", exit: 2 })
    expect((await asked()).code).toBe("uncertain")
  })

  test.each([
    ["sent: false", { sent: false, to: CHAT, id: ID }],
    ["no sent", { to: CHAT, id: ID }],
    ["no id", { sent: true, to: CHAT }],
    ["an empty id", { sent: true, to: CHAT, id: "" }],
    ["no data", null],
  ])("is uncertain when wacli reports success with %s", async (_what, data) => {
    answerSend({ stdout: envelope(data) })
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })

  test("is uncertain when wacli exits 0 with output that is no result", async () => {
    answerSend({ stdout: "Sent to someone\n" })
    expect((await asked()).code).toBe("uncertain")
  })
})
