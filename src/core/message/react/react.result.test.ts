import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BOB, TEAM, wacliChat } from "../../chat/read.testing"
import { ToolError, type ErrorCode } from "../../errors"
import { MESSAGE_REACT_OP } from "../../whatsapp/react"
import { envelope, failure } from "../../whatsapp/wacli.testing"
import { CHAT, MESSAGE_ID, THUMBS_UP, createReactTest, messageRow, type ReactTest } from "./react.testing"

let t: ReactTest

beforeEach(async () => {
  t = await createReactTest()
})

afterEach(async () => {
  await t.close()
})

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/
const ARGS = { chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP }

describe("the result", () => {
  test("names the chat, the message and the emoji, the time it was accepted in local time, and what accepted means", async () => {
    await t.serve()
    const before = Date.now()
    const result = await t.run({ ...ARGS, chat: "15550100001:7@s.whatsapp.net" })
    expect(result).toEqual({
      chat: CHAT,
      id: MESSAGE_ID,
      emoji: THUMBS_UP,
      time: expect.stringMatching(LOCAL_TIME),
      note: result.note,
    })
    expect(Date.parse(result.time)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(result.time)).toBeLessThanOrEqual(Date.now())
    expect(result.note).toContain("not delivered or seen")
    expect(result.note).toContain("replaces the user's earlier one")
    expect(result).not.toHaveProperty("errors")
    const [call] = await t.reactCalls()
    expect(call!.argv.slice(call!.argv.indexOf("send"))).toEqual([
      "send",
      "react",
      "--timeout",
      "60s",
      "--to",
      CHAT,
      "--id",
      MESSAGE_ID,
      "--reaction",
      THUMBS_UP,
      "--sender",
      CHAT,
    ])
  })

  test("has a null emoji when the reaction was removed, and wacli was given an empty reaction", async () => {
    await t.serve()
    const result = await t.run({ chat: CHAT, id: MESSAGE_ID, remove: true })
    expect(result).toMatchObject({ chat: CHAT, id: MESSAGE_ID, emoji: null })
    const [call] = await t.reactCalls()
    const at = call!.argv.indexOf("--reaction")
    expect(call!.argv.slice(at, at + 2)).toEqual(["--reaction", ""])
  })

  test("is still the result when wacli could not write the reaction to the mirror, with errors.record saying why", async () => {
    await t.serve({
      react: {
        stdout: envelope({ sent: true, to: CHAT, id: "3EB0FFFFFFFFFFFF", store_warning: "message update: disk full" }),
      },
    })
    expect(await t.run(ARGS)).toMatchObject({
      id: MESSAGE_ID,
      emoji: THUMBS_UP,
      errors: { record: "message update: disk full" },
    })
  })
})

describe("the sender wacli is told", () => {
  const GROUP_MIRROR = (change: Record<string, unknown>) => ({
    chats: [wacliChat({ jid: TEAM, kind: "group", name: "Team" })],
    messages: [messageRow({ chat: TEAM, ...change })],
  })

  test("is none for the user's own message in a person's chat", async () => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT })], messages: [messageRow({ FromMe: true })] } })
    await t.run(ARGS)
    expect(await t.reactCalls()).toHaveLength(1)
    expect(await t.sender()).toBeUndefined()
  })

  test("is the user's own JID for the user's own message in a group", async () => {
    await t.serve({ mirror: GROUP_MIRROR({ FromMe: true }) })
    await t.run({ ...ARGS, chat: TEAM })
    expect(await t.sender()).toBe("15550100000@s.whatsapp.net")
  })

  test("is the author the mirror names for someone else's message in a person's chat", async () => {
    await t.serve({
      mirror: {
        chats: [wacliChat({ jid: CHAT })],
        messages: [messageRow({ SenderJID: "15550100009@s.whatsapp.net" })],
      },
    })
    await t.run(ARGS)
    expect(await t.sender()).toBe("15550100009@s.whatsapp.net")
  })

  test("is the chat itself for someone else's message in a person's chat when the mirror names none", async () => {
    await t.serve({
      mirror: { chats: [wacliChat({ jid: BOB })], messages: [messageRow({ chat: BOB, SenderJID: "" })] },
    })
    await t.run({ ...ARGS, chat: BOB })
    expect(await t.sender()).toBe(BOB)
  })

  test("is the author the mirror names for someone else's message in a group, without the device", async () => {
    await t.serve({ mirror: GROUP_MIRROR({ SenderJID: "15550100002:12@s.whatsapp.net" }) })
    await t.run({ ...ARGS, chat: TEAM })
    expect(await t.sender()).toBe(BOB)
  })
})

describe("a reaction that ends in a failure", () => {
  test.each([
    ["react timed out after 45s"],
    ["delegated react failed after dispatch and may still have gone through; check before retrying: context canceled"],
  ])("%p is uncertain, telling to read the chat before reacting again", async (text) => {
    await t.serve({ react: { stderr: failure(text), exit: 1 } })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("The reaction may have gone out")
    expect(error.message).toContain("whatsapp_chat_read")
    expect(error.message).toContain("never repeat it on your own")
  })

  test("is uncertain when the service stops answering, and wacli is not asked again", async () => {
    await t.serve({ react: { hang: true } })
    const controller = new AbortController()
    const pending = t.failure(ARGS, controller.signal)
    await t.reactedOnce()
    controller.abort()
    expect((await pending).code).toBe("uncertain")
    expect(await t.reactCalls()).toHaveLength(1)
  })

  test("is uncertain when the service's answer cannot be read, since the reaction may have gone out", async () => {
    await t.serve({
      operations: {
        [MESSAGE_REACT_OP]: { kind: "delegated", writes: true, run: async () => ({ accepted_ms: "now" }) },
      },
    })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("never repeat it on your own")
  })

  test.each<[string, ErrorCode]>([
    ["--sender is required for group reactions", "invalid_argument"],
    ["invalid --sender: unknown server", "invalid_argument"],
    ["request timed out in the send queue before dispatch; it was not sent", "upstream_error"],
  ])("keeps its code when wacli says %p", async (text, code) => {
    await t.serve({ react: { stderr: failure(text), exit: 1 } })
    const error = await t.failure(ARGS)
    expect(error.code).toBe(code)
    expect(error.message).toContain("Nothing")
  })

  test("is upstream_error without a running service, saying to start it, and nothing is reacted to", async () => {
    t.setUp()
    const error = await t.failure(ARGS)
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("is not running; start it first")
    expect(error.message).toContain("whatsapp_account_read")
    expect(await t.reactCalls()).toEqual([])
  })

  test("is not_found for an account that is not paired, before anything runs", async () => {
    await t.serve()
    const error = await t.failure({ ...ARGS, account: "other" })
    expect(error.code).toBe("not_found")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("is the abort itself when the call is aborted before it reaches the service, and nothing is reacted to", async () => {
    await t.serve()
    const controller = new AbortController()
    controller.abort()
    const error = await t.failure(ARGS, controller.signal).catch((thrown: unknown) => thrown)
    expect(error).not.toBeInstanceOf(ToolError)
    expect(await t.reactCalls()).toEqual([])
  })
})
