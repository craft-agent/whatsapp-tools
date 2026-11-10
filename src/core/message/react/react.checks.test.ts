import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BOB, HIDDEN, TEAM, wacliChat } from "../../chat/read.testing"
import { ToolError } from "../../errors"
import { MS_PER_MINUTE } from "../../time"
import { AUTHOR, CHAT, MESSAGE_ID, THUMBS_UP, ago, createReactTest, messageRow, type ReactTest } from "./react.testing"

let t: ReactTest

beforeEach(async () => {
  t = await createReactTest()
})

afterEach(async () => {
  await t.close()
})

const ARGS = { chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP }

/** Runs the call against a mirror holding the chat and `messages`, expecting the tool to refuse it before wacli reacts. */
async function refused(
  messages: Record<string, unknown>[],
  change: Record<string, unknown> = {},
  polls: Record<string, unknown>[] = [],
): Promise<ToolError> {
  await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT })], messages, polls } })
  const error = await t.failure({ ...ARGS, ...change })
  expect(await t.reactCalls()).toEqual([])
  return error
}

describe("the chat", () => {
  test("is not_found when the mirror does not hold it, pointing to the chat list", async () => {
    await t.serve()
    const error = await t.failure({ ...ARGS, chat: HIDDEN })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("whatsapp_chat_read list")
    expect(await t.reactCalls()).toEqual([])
  })

  test("is invalid_argument when the mirror says it is neither a person nor a group", async () => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT, kind: "broadcast" })], messages: [messageRow()] } })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("people and groups only")
    expect(await t.reactCalls()).toEqual([])
  })

  test("may be a group", async () => {
    const row = messageRow({ chat: TEAM })
    await t.serve({ mirror: { chats: [wacliChat({ jid: TEAM, kind: "group", name: "Team" })], messages: [row] } })
    expect(await t.run({ ...ARGS, chat: TEAM })).toMatchObject({ chat: TEAM, id: MESSAGE_ID })
  })
})

describe("the message", () => {
  test("is not_found when the chat has no message with this id", async () => {
    const error = await refused([messageRow()], { id: "NOSUCHMESSAGE" })
    expect(error.code).toBe("not_found")
  })

  test.each([
    ["deleted for everyone", { Revoked: true }],
    ["deleted for the user", { DeletedForMe: true }],
  ])("is not_found when it was %s", async (_what, change) => {
    const error = await refused([messageRow(change)])
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("deleted")
  })

  test("is not_found when wacli kept it for traffic it could not read", async () => {
    const error = await refused([messageRow({ Text: "", DisplayText: "(message)" })])
    expect(error.code).toBe("not_found")
  })

  test("is invalid_argument for a reaction", async () => {
    const error = await refused([messageRow({ Text: "", ReactionEmoji: "👍", ReactionToID: "3EB0AAAAAAAAAAAA" })])
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("reaction")
  })

  test.each([
    ["a vote on a poll", { Text: "Poll vote" }],
    ["an option added to a poll", { Text: "Poll option added" }],
  ])("is invalid_argument when it is %s", async (_what, change) => {
    const error = await refused([messageRow(change)])
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("cannot be reacted to")
    expect(error.message).toContain("Nothing was changed")
  })

  test("is invalid_argument when it is a call", async () => {
    const call = messageRow({ Text: "", DisplayText: "WhatsApp audio call connected (1m01s)" })
    const calls = [{ chat_jid: CHAT, msg_id: MESSAGE_ID, timestamp: call.Timestamp }]
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT })], messages: [call], calls } })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("cannot be reacted to")
    expect(await t.reactCalls()).toEqual([])
  })

  test("is reacted to when it is a poll", async () => {
    await t.serve({
      mirror: {
        chats: [wacliChat({ jid: CHAT })],
        messages: [messageRow({ Text: "Poll: Lunch?" })],
        polls: [{ chat_jid: CHAT, msg_id: MESSAGE_ID, question: "Lunch?" }],
      },
    })
    expect(await t.run(ARGS)).toMatchObject({ id: MESSAGE_ID })
  })

  test.each([
    ["the other person's", {}],
    ["the user's own", { FromMe: true }],
    ["an hour old", { at: ago(60 * MS_PER_MINUTE) }],
    ["a day old", { at: ago(24 * 60 * MS_PER_MINUTE) }],
    ["a photo", { MediaType: "image", Text: "", MediaCaption: "Look" }],
  ])("is reacted to when it is %s", async (_what, change) => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT })], messages: [messageRow(change)] } })
    expect(await t.run(ARGS)).toMatchObject({ id: MESSAGE_ID })
    expect(await t.reactCalls()).toHaveLength(1)
  })
})

describe("the author of the message", () => {
  const GROUP_MIRROR = (change: Record<string, unknown>) => ({
    chats: [wacliChat({ jid: TEAM, kind: "group", name: "Team" })],
    messages: [messageRow({ chat: TEAM, ...change })],
  })

  test("is refused as upstream_error, before anything is sent, when the mirror does not say who wrote a group message", async () => {
    await t.serve({ mirror: GROUP_MIRROR({ SenderJID: "" }) })
    const error = await t.failure({ ...ARGS, chat: TEAM })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("does not say who wrote this message")
    expect(await t.reactCalls()).toEqual([])
  })

  test("is refused the same way for the user's own group message that names no author", async () => {
    await t.serve({ mirror: GROUP_MIRROR({ SenderJID: "", FromMe: true }) })
    const error = await t.failure({ ...ARGS, chat: TEAM })
    expect(error.code).toBe("upstream_error")
    expect(await t.reactCalls()).toEqual([])
  })

  test("is the chat itself for someone else's message in a person's chat that names no author", async () => {
    await t.serve({
      mirror: { chats: [wacliChat({ jid: BOB })], messages: [messageRow({ chat: BOB, SenderJID: "" })] },
    })
    await t.run({ ...ARGS, chat: BOB })
    expect(await t.sender()).toBe(BOB)
  })

  test("is told to wacli for a group message, from the mirror", async () => {
    await t.serve({ mirror: GROUP_MIRROR({}) })
    await t.run({ ...ARGS, chat: TEAM })
    expect(await t.sender()).toBe(AUTHOR)
  })
})
