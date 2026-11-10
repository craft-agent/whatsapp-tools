import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { HIDDEN, TEAM, wacliChat } from "../../chat/read.testing"
import { ToolError } from "../../errors"
import { MS_PER_MINUTE } from "../../time"
import { CHAT, MESSAGE_ID, ago, createDeleteTest, ownMessageRow, type DeleteTest } from "./delete.testing"

let t: DeleteTest

beforeEach(async () => {
  t = await createDeleteTest()
})

afterEach(async () => {
  await t.close()
})

const MS_PER_HOUR = 60 * MS_PER_MINUTE

/** Runs the call against a mirror holding the chat and `messages`, expecting the tool to refuse it before the service stops its child. */
async function refused(
  messages: Record<string, unknown>[],
  calls: Record<string, unknown>[] = [],
  polls: Record<string, unknown>[] = [],
): Promise<ToolError> {
  await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT })], messages, polls, calls } })
  const error = await t.failure({ chat: CHAT, id: MESSAGE_ID })
  expect(await t.deleteCalls()).toEqual([])
  expect(t.fixture.logs).not.toContain("event stopping")
  expect(await t.fixture.syncCalls()).toHaveLength(1)
  return error
}

describe("the chat", () => {
  test("is not_found when the mirror does not hold it, pointing to the chat list", async () => {
    await t.serve()
    const error = await t.failure({ chat: HIDDEN, id: MESSAGE_ID })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("whatsapp_chat_read list")
    expect(await t.deleteCalls()).toEqual([])
  })

  test("is invalid_argument when the mirror says it is neither a person nor a group", async () => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT, kind: "broadcast" })], messages: [ownMessageRow()] } })
    const error = await t.failure({ chat: CHAT, id: MESSAGE_ID })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("people and groups only")
    expect(await t.deleteCalls()).toEqual([])
  })

  test("may be a group", async () => {
    const row = ownMessageRow({ chat: TEAM })
    await t.serve({ mirror: { chats: [wacliChat({ jid: TEAM, kind: "group", name: "Team" })], messages: [row] } })
    expect(await t.run({ chat: TEAM, id: MESSAGE_ID })).toMatchObject({ chat: TEAM, id: MESSAGE_ID, deleted: true })
  })
})

describe("the message", () => {
  test("is not_found when the chat has no message with this id", async () => {
    await t.serve()
    const error = await t.failure({ chat: CHAT, id: "NOSUCHMESSAGE" })
    expect(error.code).toBe("not_found")
    expect(await t.deleteCalls()).toEqual([])
  })

  test.each([
    ["deleted for everyone", { Revoked: true }],
    ["deleted for the user", { DeletedForMe: true }],
  ])("is not_found when it was %s", async (_what, change) => {
    const error = await refused([ownMessageRow(change)])
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("deleted")
  })

  test("is not_found when wacli kept it for traffic it could not read", async () => {
    const error = await refused([ownMessageRow({ Text: "", DisplayText: "(message)" })])
    expect(error.code).toBe("not_found")
  })

  test("is invalid_argument for a reaction", async () => {
    const error = await refused([ownMessageRow({ Text: "", ReactionEmoji: "👍", ReactionToID: "3EB0AAAAAAAAAAAA" })])
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("reaction")
  })

  test("is forbidden when someone else wrote it", async () => {
    const error = await refused([ownMessageRow({ FromMe: false })])
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("own messages")
  })

  test("is forbidden when it was sent more than two days ago, saying so", async () => {
    const error = await refused([ownMessageRow({ at: ago(49 * MS_PER_HOUR) })])
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("two days")
    expect(error.message).toContain("Nothing was changed")
  })

  test("is deleted when it was sent just inside the two days", async () => {
    await t.serve({
      mirror: { chats: [wacliChat({ jid: CHAT })], messages: [ownMessageRow({ at: ago(47 * MS_PER_HOUR) })] },
    })
    expect(await t.run({ chat: CHAT, id: MESSAGE_ID })).toMatchObject({ id: MESSAGE_ID, deleted: true })
  })

  test("is invalid_argument when it is a call", async () => {
    const call = ownMessageRow({ Text: "", DisplayText: "WhatsApp audio call connected (1m01s)" })
    const error = await refused([call], [{ chat_jid: CHAT, msg_id: MESSAGE_ID, timestamp: call.Timestamp }])
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("call")
  })

  test.each([
    ["a photo", { MediaType: "image", Text: "" }],
    ["a photo with a caption", { MediaType: "image", Text: "", MediaCaption: "Sunset" }],
    ["a file", { MediaType: "document", Text: "", DisplayText: "report.pdf", Filename: "report.pdf" }],
    ["a vote on a poll", { Text: "Poll vote" }],
  ])("is deleted when it is %s", async (_what, change) => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT })], messages: [ownMessageRow(change)] } })
    expect(await t.run({ chat: CHAT, id: MESSAGE_ID })).toMatchObject({ id: MESSAGE_ID, deleted: true })
  })

  test("is deleted when it is a poll", async () => {
    const poll = ownMessageRow({ Text: "Poll: Lunch?" })
    await t.serve({
      mirror: {
        chats: [wacliChat({ jid: CHAT })],
        messages: [poll],
        polls: [{ chat_jid: CHAT, msg_id: MESSAGE_ID, question: "Lunch?" }],
      },
    })
    expect(await t.run({ chat: CHAT, id: MESSAGE_ID })).toMatchObject({ id: MESSAGE_ID, deleted: true })
  })
})
