import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { ToolError, type ErrorCode } from "../errors"
import { CHAT_ARCHIVE_OP, CHAT_MUTE_OP, CHAT_PIN_OP, CHAT_STATE_DEADLINE_MS, chatStateAnswer } from "./chat-state"
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

/** Has the fake answer every `chats` command as `response` says. */
function answerChats(response: Omit<FakeResponse, "args">): void {
  fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["chats"], ...response }])
}

const doneEnvelope = (action = "archive", chat = CHAT) => envelope({ ok: true, action, chat })

const ask = (op: string, args: unknown, timeoutMs = CHAT_STATE_DEADLINE_MS) =>
  callService(fixture.paths, op, args, { mode: "write", timeoutMs }).catch((error: unknown) => {
    if (error instanceof ToolError) return error
    throw error
  })

const chatsCalls = async () => (await fixture.fake.calls()).filter((call) => call.argv.includes("chats"))

/** The arguments of the one `chats` call the fake got, after the global flags. */
async function chatsArgv(): Promise<string[]> {
  const [call, ...others] = await chatsCalls()
  expect(others).toEqual([])
  return call!.argv.slice(call!.argv.indexOf("chats"))
}

const STATES: [string, string, Record<string, unknown>, string[]][] = [
  [CHAT_ARCHIVE_OP, "archive", { archived: true }, ["archive"]],
  [CHAT_ARCHIVE_OP, "unarchive", { archived: false }, ["unarchive"]],
  [CHAT_PIN_OP, "pin", { pinned: true }, ["pin"]],
  [CHAT_PIN_OP, "unpin", { pinned: false }, ["unpin"]],
  [CHAT_MUTE_OP, "mute for 8 hours", { mute: "8_hours" }, ["mute", "--duration", "8h"]],
  [CHAT_MUTE_OP, "mute for a week", { mute: "1_week" }, ["mute", "--duration", "168h"]],
  [CHAT_MUTE_OP, "mute always", { mute: "always" }, ["mute", "--duration", "0"]],
  [CHAT_MUTE_OP, "unmute", { mute: "off" }, ["unmute"]],
]

describe("the chat state operations", () => {
  test.each([CHAT_ARCHIVE_OP, CHAT_PIN_OP, CHAT_MUTE_OP])(
    "%s is a delegated one that writes, so that a stop or a deadline during it is uncertain",
    (op) => {
      expect(serviceOperations()[op]).toMatchObject({ kind: "delegated", writes: true })
    },
  )

  test.each(STATES)(
    "%s runs wacli for %s without --read-only, with its own time-out",
    async (op, _what, change, command) => {
      answerChats({ stdout: doneEnvelope() })
      expect(await ask(op, { chat: CHAT, ...change })).toHaveProperty("accepted_ms")
      const [call] = await chatsCalls()
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
    },
  )

  test("answers with when it was accepted", async () => {
    answerChats({ stdout: doneEnvelope("pin") })
    const before = Date.now()
    const answer = chatStateAnswer.parse(await ask(CHAT_PIN_OP, { chat: GROUP, pinned: true }))
    expect(answer.accepted_ms).toBeGreaterThanOrEqual(before)
    expect(answer.accepted_ms).toBeLessThanOrEqual(Date.now())
    expect(await chatsArgv()).toEqual(["chats", "pin", "--timeout", "60s", "--chat", GROUP])
  })

  test.each([
    [CHAT_ARCHIVE_OP, "a chat that is not a JID", { chat: "Alice", archived: true }],
    [CHAT_ARCHIVE_OP, "a channel", { chat: "120363000000000002@newsletter", archived: true }],
    [CHAT_ARCHIVE_OP, "a broadcast list", { chat: "1555010000199@broadcast", archived: true }],
    [CHAT_ARCHIVE_OP, "a missing chat", { archived: true }],
    [CHAT_ARCHIVE_OP, "a missing archived", { chat: CHAT }],
    [CHAT_ARCHIVE_OP, "an archived that is not a boolean", { chat: CHAT, archived: "yes" }],
    [CHAT_PIN_OP, "a missing pinned", { chat: CHAT }],
    [CHAT_PIN_OP, "a pinned that is not a boolean", { chat: CHAT, pinned: 1 }],
    [CHAT_PIN_OP, "an argument it does not know", { chat: CHAT, pinned: true, archived: true }],
    [CHAT_MUTE_OP, "a missing mute", { chat: CHAT }],
    [CHAT_MUTE_OP, "a mute it does not offer", { chat: CHAT, mute: "24_hours" }],
    [CHAT_MUTE_OP, "a duration instead of a mute", { chat: CHAT, mute: "8h" }],
    [CHAT_MUTE_OP, "an argument it does not know", { chat: CHAT, mute: "off", duration: "8h" }],
  ])("%s refuses %s as invalid_argument, and runs nothing", async (op, _what, args) => {
    answerChats({ stdout: doneEnvelope() })
    const error = await ask(op, args)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await chatsCalls()).toEqual([])
  })

  test("is uncertain when the deadline passes while wacli has not answered, and wacli is stopped", async () => {
    answerChats({ hang: true })
    const error = await ask(CHAT_PIN_OP, { chat: CHAT, pinned: true }, 3000)
    expect((error as ToolError).code).toBe("uncertain")
    expect(await chatsCalls()).toHaveLength(1)
  })
})

describe("what wacli says when the change fails", () => {
  const fails = (text: string) => answerChats({ stderr: failure(text), exit: 1 })
  const asked = () => ask(CHAT_ARCHIVE_OP, { chat: CHAT, archived: true }) as Promise<ToolError>

  test.each<[string, ErrorCode]>([
    ["--chat is required", "invalid_argument"],
    ["the running sync process does not support delegated chats archive; restart `wacli sync`", "upstream_error"],
    ["request deadline passed before dispatch; it was not sent", "upstream_error"],
    ["read-only mode: chats archive is refused", "invalid_argument"],
    ["not authenticated; run `wacli auth`", "unauthenticated"],
    ["store is locked (another wacli is running?): locked", "upstream_error"],
  ])("%s is %s, and nothing was changed", async (text, code) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("15550100001")
  })

  test("names the change when the request ended before dispatch, and says trying again is safe", async () => {
    fails("request deadline passed before dispatch; it was not sent")
    const message = (await asked()).message
    expect(message).toStartWith("WhatsApp did not get the change:")
    expect(message).toEndWith("Nothing was changed; trying again is safe.")
  })

  test("tells the sync to restart when its wacli does not take the change", async () => {
    fails("the running sync process does not support delegated chats archive; restart `wacli sync`")
    expect((await asked()).message).toContain("restart the sync service")
  })

  test.each([
    ["delegated chat_state failed after dispatch and may still have gone through; check before retrying: deadline"],
    ["no reply from the running sync process before the timeout; the change may still have gone through"],
    ["wait for missing WhatsApp app state key during regular_low recovery: context deadline exceeded"],
    ["--chat is required, though it may still have gone through"],
    ["connection lost; reconnect failed: dial tcp: i/o timeout"],
    ["wacli says --chat is required later in its text"],
    ["something wacli has never said"],
    [""],
  ])("%p is uncertain", async (text) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })

  test("is uncertain when wacli exits 1 without a result, or ends with output that is no result", async () => {
    answerChats({ stderr: "panic: runtime error\n", exit: 1 })
    expect((await asked()).code).toBe("uncertain")
    answerChats({ stdout: "archive: 1555\n", exit: 2 })
    expect((await asked()).code).toBe("uncertain")
    answerChats({ stdout: "archive\n" })
    expect((await asked()).code).toBe("uncertain")
  })

  test.each([
    ["ok: false", { ok: false, action: "archive", chat: CHAT }],
    ["no ok", { action: "archive", chat: CHAT }],
    ["no data", null],
  ])("is uncertain when wacli reports success with %s", async (_what, data) => {
    answerChats({ stdout: envelope(data) })
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })
})
