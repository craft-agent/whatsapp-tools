import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { ToolError, type ErrorCode } from "../errors"
import { ACCEPTED, REFUSED } from "../message/emoji.testing"
import { serviceOperations } from "./operations"
import { MESSAGE_REACT_DEADLINE_MS, MESSAGE_REACT_OP, reactAnswer } from "./react"
import { callService } from "./service-client"
import { DOCTOR_OK, HANGING_SYNC, startService, syncFixture, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope, failure, type FakeResponse } from "./wacli.testing"

const CHAT = "15550100001@s.whatsapp.net"
const GROUP = "120363000000000001@g.us"
const SENDER = "15550100002@s.whatsapp.net"
const ID = "3EB0A1B2C3D4E5F6"
const THUMBS_UP = "\u{1F44D}"

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

/** Has the fake answer the reaction as `response` says. */
function answerReact(response: Omit<FakeResponse, "args">): void {
  fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["send", "react"], ...response }])
}

const reactedEnvelope = (data: Record<string, unknown> = {}) =>
  envelope({ sent: true, to: CHAT, id: "3EB0FFFFFFFFFFFF", target: ID, reaction: THUMBS_UP, ...data })

const ask = (args: unknown, timeoutMs = MESSAGE_REACT_DEADLINE_MS) =>
  callService(fixture.paths, MESSAGE_REACT_OP, args, { mode: "write", timeoutMs }).catch((error: unknown) => {
    if (error instanceof ToolError) return error
    throw error
  })

const reactCalls = async () => (await fixture.fake.calls()).filter((call) => call.argv.includes("react"))

describe("the message_react operation", () => {
  test("is a delegated one that writes, so that a stop or a deadline during it is uncertain", () => {
    expect(serviceOperations()[MESSAGE_REACT_OP]).toMatchObject({ kind: "delegated", writes: true })
  })

  test("answers with when it was accepted", async () => {
    answerReact({ stdout: reactedEnvelope() })
    const before = Date.now()
    const answer = reactAnswer.parse(await ask({ chat: CHAT, id: ID, reaction: THUMBS_UP }))
    expect(answer.accepted_ms).toBeGreaterThanOrEqual(before)
    expect(answer.accepted_ms).toBeLessThanOrEqual(Date.now())
    expect(answer).not.toHaveProperty("store_warning")
  })

  test("passes on the warning wacli gives for writing the mirror, with numbers masked", async () => {
    answerReact({ stdout: reactedEnvelope({ store_warning: "message update: disk full for 15550100001" }) })
    expect(await ask({ chat: CHAT, id: ID, reaction: THUMBS_UP })).toMatchObject({
      store_warning: "message update: disk full for <number>",
    })
  })

  test("runs wacli without --read-only, with its own time-out, and no --sender when none is given", async () => {
    answerReact({ stdout: reactedEnvelope() })
    await ask({ chat: CHAT, id: ID, reaction: THUMBS_UP })
    const [call, ...others] = await reactCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual([
      "--store",
      fixture.paths.store,
      "--json",
      "send",
      "react",
      "--timeout",
      "60s",
      "--to",
      CHAT,
      "--id",
      ID,
      "--reaction",
      THUMBS_UP,
    ])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test("adds --sender for a group message", async () => {
    answerReact({ stdout: reactedEnvelope({ to: GROUP }) })
    await ask({ chat: GROUP, id: ID, reaction: THUMBS_UP, sender: SENDER })
    const [call] = await reactCalls()
    expect(call!.argv.slice(call!.argv.indexOf("send"))).toEqual([
      "send",
      "react",
      "--timeout",
      "60s",
      "--to",
      GROUP,
      "--id",
      ID,
      "--reaction",
      THUMBS_UP,
      "--sender",
      SENDER,
    ])
  })

  test("passes an empty reaction, which removes the user's, as an empty argument", async () => {
    answerReact({ stdout: reactedEnvelope({ reaction: "" }) })
    expect(await ask({ chat: CHAT, id: ID, reaction: "" })).toHaveProperty("accepted_ms")
    const [call] = await reactCalls()
    const at = call!.argv.indexOf("--reaction")
    expect(call!.argv.slice(at)).toEqual(["--reaction", ""])
  })

  test.each(ACCEPTED)("takes %s", async (_name, emoji) => {
    answerReact({ stdout: reactedEnvelope({ reaction: emoji }) })
    expect(await ask({ chat: CHAT, id: ID, reaction: emoji })).toHaveProperty("accepted_ms")
  })

  test.each([
    ["a chat that is not a JID", { chat: "Alice" }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["a broadcast list", { chat: "1555010000199@broadcast" }],
    ["a missing chat", { chat: undefined }],
    ["an id that is not a message id", { id: "-x" }],
    ["a missing id", { id: undefined }],
    ["a missing reaction", { reaction: undefined }],
    ["a reaction that is not text", { reaction: 5 }],
    ["a reaction of two emoji", { reaction: `${THUMBS_UP}${THUMBS_UP}` }],
    ["a reaction of words", { reaction: "like" }],
    ["a reaction with blank space", { reaction: ` ${THUMBS_UP}` }],
    ["a sender that is not a JID", { sender: "Bob" }],
    ["a sender that starts a flag", { sender: "--chat=x@y" }],
    ["an argument it does not know", { preview: true }],
  ])("refuses %s as invalid_argument, and runs nothing", async (_what, change) => {
    answerReact({ stdout: reactedEnvelope() })
    const error = await ask({ chat: CHAT, id: ID, reaction: THUMBS_UP, ...change })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await reactCalls()).toEqual([])
  })

  test.each(REFUSED.filter(([, text]) => text !== ""))("refuses %s as a reaction", async (_what, reaction) => {
    answerReact({ stdout: reactedEnvelope() })
    expect(((await ask({ chat: CHAT, id: ID, reaction })) as ToolError).code).toBe("invalid_argument")
    expect(await reactCalls()).toEqual([])
  })

  test("is uncertain when the deadline passes while wacli has not answered, and wacli is stopped", async () => {
    answerReact({ hang: true })
    const error = await ask({ chat: CHAT, id: ID, reaction: THUMBS_UP }, 3000)
    expect((error as ToolError).code).toBe("uncertain")
    expect(await reactCalls()).toHaveLength(1)
  })
})

describe("what wacli says when the reaction fails", () => {
  const fails = (text: string) => answerReact({ stderr: failure(text), exit: 1 })
  const asked = () => ask({ chat: GROUP, id: ID, reaction: THUMBS_UP, sender: SENDER }) as Promise<ToolError>

  test.each<[string, ErrorCode]>([
    ["--to and --id are required", "invalid_argument"],
    ["--sender is required for group reactions", "invalid_argument"],
    ["invalid --sender: unknown server", "invalid_argument"],
    ["invalid --to: unknown server", "invalid_argument"],
    ["request timed out in the send queue before dispatch; it was not sent", "upstream_error"],
    ["read-only mode: send is refused", "invalid_argument"],
    ["not authenticated; run `wacli auth`", "unauthenticated"],
    ["store is locked (another wacli is running?): locked", "upstream_error"],
  ])("%s is %s, and nothing was changed", async (text, code) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("15550100001")
  })

  test("names the reaction when the queue dropped it", async () => {
    fails("request timed out in the send queue before dispatch; it was not sent")
    const message = (await asked()).message
    expect(message).toStartWith("WhatsApp did not get the reaction:")
    expect(message).toEndWith("Nothing was changed; trying again is safe.")
  })

  test.each([
    ["delegated react failed after dispatch and may still have gone through; check before retrying: deadline"],
    ["no reply from the running sync process before the timeout; the reaction may still have gone through"],
    ["--sender is required for group reactions, though it may still have gone through"],
    ["react timed out after 45s"],
    ["connection lost; reconnect failed: dial tcp: i/o timeout"],
    ["wacli says invalid --sender later in its text"],
    ["something wacli has never said"],
    [""],
  ])("%p is uncertain", async (text) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })

  test("is uncertain when wacli exits 1 without a result, or ends with output that is no result", async () => {
    answerReact({ stderr: "panic: runtime error\n", exit: 1 })
    expect((await asked()).code).toBe("uncertain")
    answerReact({ stdout: "not json\n", exit: 2 })
    expect((await asked()).code).toBe("uncertain")
    answerReact({ stdout: "Reacted\n" })
    expect((await asked()).code).toBe("uncertain")
  })

  test.each([
    ["sent: false", { sent: false, to: GROUP, id: ID }],
    ["no sent", { to: GROUP, id: ID }],
    ["no data", null],
  ])("is uncertain when wacli reports success with %s", async (_what, data) => {
    answerReact({ stdout: envelope(data) })
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })
})
