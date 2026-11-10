import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { ToolError, type ErrorCode } from "../errors"
import { MESSAGE_EDIT_DEADLINE_MS, MESSAGE_EDIT_OP, editAnswer } from "./edit"
import { serviceOperations } from "./operations"
import { MESSAGE_TEXT_MAX_CHARACTERS } from "./send"
import { callService } from "./service-client"
import { DOCTOR_OK, HANGING_SYNC, startService, syncFixture, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope, failure, type FakeResponse } from "./wacli.testing"

const CHAT = "15550100001@s.whatsapp.net"
const ID = "3EB0A1B2C3D4E5F6"
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

/** Has the fake answer the edit as `response` says. */
function answerEdit(response: Omit<FakeResponse, "args">): void {
  fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["messages", "edit"], ...response }])
}

const editedEnvelope = (data: Record<string, unknown> = {}) =>
  envelope({ edited: true, to: CHAT, id: ID, target: ID, message: TEXT, ...data })

const ask = (args: unknown, timeoutMs = MESSAGE_EDIT_DEADLINE_MS) =>
  callService(fixture.paths, MESSAGE_EDIT_OP, args, { mode: "write", timeoutMs }).catch((error: unknown) => {
    if (error instanceof ToolError) return error
    throw error
  })

const editCalls = async () => (await fixture.fake.calls()).filter((call) => call.argv.includes("edit"))

describe("the message_edit operation", () => {
  test("is a delegated one that writes, so that a stop or a deadline during it is uncertain", () => {
    expect(serviceOperations()[MESSAGE_EDIT_OP]).toMatchObject({ kind: "delegated", writes: true })
  })

  test("answers with when it was accepted, and the warning wacli gives for writing the mirror", async () => {
    answerEdit({ stdout: editedEnvelope() })
    const before = Date.now()
    const answer = editAnswer.parse(await ask({ chat: CHAT, id: ID, text: TEXT }))
    expect(answer.accepted_ms).toBeGreaterThanOrEqual(before)
    expect(answer.accepted_ms).toBeLessThanOrEqual(Date.now())
    expect(answer).not.toHaveProperty("store_warning")
  })

  test("is still a success when WhatsApp took the edit and wacli could not write the new text to the mirror", async () => {
    answerEdit({
      stderr: failure("store edited message text: disk full for 15550100001"),
      exit: 1,
    })
    expect(await ask({ chat: CHAT, id: ID, text: TEXT })).toMatchObject({
      store_warning: "store edited message text: disk full for <number>",
    })
  })

  test("runs wacli without --read-only, with its own time-out, and the text as one argument", async () => {
    answerEdit({ stdout: editedEnvelope() })
    const text = "--help -x\nline two ✓"
    await ask({ chat: CHAT, id: ID, text })
    const [call, ...others] = await editCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual([
      "--store",
      fixture.paths.store,
      "--json",
      "messages",
      "edit",
      "--timeout",
      "60s",
      "--chat",
      CHAT,
      "--id",
      ID,
      "--message",
      text,
    ])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test("takes 4000 characters counted as code points and refuses 4001", async () => {
    answerEdit({ stdout: editedEnvelope() })
    expect(await ask({ chat: CHAT, id: ID, text: "😀".repeat(MESSAGE_TEXT_MAX_CHARACTERS) })).toHaveProperty(
      "accepted_ms",
    )
    const error = await ask({ chat: CHAT, id: ID, text: "😀".repeat(MESSAGE_TEXT_MAX_CHARACTERS + 1) })
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await editCalls()).toHaveLength(1)
  })

  test.each([
    ["a chat that is not a JID", { chat: "Alice" }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["a broadcast list", { chat: "1555010000199@broadcast" }],
    ["a missing chat", { chat: undefined }],
    ["an id that is not a message id", { id: "-x" }],
    ["a missing id", { id: undefined }],
    ["an empty text", { text: "" }],
    ["a text that is not text", { text: 5 }],
    ["half of a character", { text: "hi \uD83D" }],
    ["an argument it does not know", { preview: true }],
  ])("refuses %s as invalid_argument, and runs nothing", async (_what, change) => {
    answerEdit({ stdout: editedEnvelope() })
    const error = await ask({ chat: CHAT, id: ID, text: TEXT, ...change })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await editCalls()).toEqual([])
  })

  test("is uncertain when the deadline passes while wacli has not answered, and wacli is stopped", async () => {
    answerEdit({ hang: true })
    const error = await ask({ chat: CHAT, id: ID, text: TEXT }, 3000)
    expect((error as ToolError).code).toBe("uncertain")
    expect(await editCalls()).toHaveLength(1)
  })
})

describe("what wacli says when the edit fails", () => {
  const fails = (text: string) => answerEdit({ stderr: failure(text), exit: 1 })
  const asked = () => ask({ chat: CHAT, id: ID, text: TEXT }) as Promise<ToolError>

  test.each<[string, ErrorCode]>([
    [`message ${ID} was not sent by me`, "forbidden"],
    [`message ${ID} is already deleted`, "not_found"],
    [`message ${ID} was deleted for me`, "not_found"],
    ["only text messages can be edited", "invalid_argument"],
    [`message ${ID} is older than WhatsApp's 15m0s edit window`, "forbidden"],
    ["--chat, --id, and --message are required", "invalid_argument"],
    ["sql: no rows in result set", "not_found"],
    ["request timed out in the send queue before dispatch; it was not sent", "upstream_error"],
    ["read-only mode: edit is refused", "invalid_argument"],
    ["not authenticated; run `wacli auth`", "unauthenticated"],
    ["store is locked (another wacli is running?): locked", "upstream_error"],
  ])("%s is %s, and nothing was changed", async (text, code) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("15550100001")
  })

  test("names the edit when the queue dropped it", async () => {
    fails("request timed out in the send queue before dispatch; it was not sent")
    const message = (await asked()).message
    expect(message).toStartWith("WhatsApp did not get the edit:")
    expect(message).toEndWith("Nothing was changed; trying again is safe.")
  })

  test("says nothing was changed for what it maps itself", async () => {
    fails(`message ${ID} was not sent by me`)
    expect((await asked()).message).toBe("Only the user's own messages can be edited. Nothing was changed.")
  })

  test.each([
    ["delegated edit failed after dispatch and may still have gone through; check before retrying: deadline"],
    ["no reply from the running sync process before the timeout; the edit may still have gone through"],
    [`message ${ID} was not sent by me, though it may still have gone through`],
    ["edit timed out after 45s"],
    ["connection lost; reconnect failed: dial tcp: i/o timeout"],
    [`wacli says message ${ID} was not sent by me later in its text`],
    ["something wacli has never said"],
    [""],
  ])("%p is uncertain", async (text) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })

  test("is uncertain when wacli exits 1 without a result, or ends with output that is no result", async () => {
    answerEdit({ stderr: "panic: runtime error\n", exit: 1 })
    expect((await asked()).code).toBe("uncertain")
    answerEdit({ stdout: "not json\n", exit: 2 })
    expect((await asked()).code).toBe("uncertain")
    answerEdit({ stdout: "Edited\n" })
    expect((await asked()).code).toBe("uncertain")
  })

  test.each([
    ["edited: false", { edited: false, to: CHAT, id: ID }],
    ["no edited", { to: CHAT, id: ID }],
    ["no data", null],
  ])("is uncertain when wacli reports success with %s", async (_what, data) => {
    answerEdit({ stdout: envelope(data) })
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })
})
