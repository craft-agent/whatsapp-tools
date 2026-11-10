import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { HIDDEN, TEAM, wacliChat } from "../../chat/read.testing"
import { ToolError } from "../../errors"
import { MS_PER_MINUTE } from "../../time"
import { CHAT, CURRENT_TEXT, MESSAGE_ID, ago, createEditTest, ownMessageRow, type EditTest } from "./edit.testing"

let t: EditTest

beforeEach(async () => {
  t = await createEditTest()
})

afterEach(async () => {
  await t.close()
})

const NEW_TEXT = "See you at 7"

/** Runs the call against a mirror holding the chat and `messages`, expecting the tool to refuse it before wacli edits anything. */
async function refused(
  messages: Record<string, unknown>[],
  change: Record<string, unknown> = {},
  polls: Record<string, unknown>[] = [],
): Promise<ToolError> {
  await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT })], messages, polls } })
  const error = await t.failure({ chat: CHAT, id: MESSAGE_ID, text: NEW_TEXT, ...change })
  expect(await t.editCalls()).toEqual([])
  return error
}

describe("the chat", () => {
  test("is not_found when the mirror does not hold it, pointing to the chat list", async () => {
    await t.serve()
    const error = await t.failure({ chat: HIDDEN, id: MESSAGE_ID, text: NEW_TEXT })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("whatsapp_chat_read list")
    expect(await t.editCalls()).toEqual([])
  })

  test("is invalid_argument when the mirror says it is neither a person nor a group", async () => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT, kind: "broadcast" })], messages: [ownMessageRow()] } })
    const error = await t.failure({ chat: CHAT, id: MESSAGE_ID, text: NEW_TEXT })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("people and groups only")
    expect(await t.editCalls()).toEqual([])
  })

  test("may be a group", async () => {
    const row = ownMessageRow({ chat: TEAM })
    await t.serve({ mirror: { chats: [wacliChat({ jid: TEAM, kind: "group", name: "Team" })], messages: [row] } })
    expect(await t.run({ chat: TEAM, id: MESSAGE_ID, text: NEW_TEXT })).toMatchObject({ chat: TEAM, id: MESSAGE_ID })
  })
})

describe("the message", () => {
  test("is not_found when the chat has no message with this id", async () => {
    const error = await refused([ownMessageRow()], { id: "NOSUCHMESSAGE" })
    expect(error.code).toBe("not_found")
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

  test("is forbidden when it was sent more than 15 minutes ago, saying so", async () => {
    const error = await refused([ownMessageRow({ at: ago(16 * MS_PER_MINUTE) })])
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("15 minutes")
    expect(error.message).toContain("Nothing was changed")
  })

  test("is edited when it was sent just inside the 15 minutes", async () => {
    await t.serve({
      mirror: { chats: [wacliChat({ jid: CHAT })], messages: [ownMessageRow({ at: ago(14 * MS_PER_MINUTE) })] },
    })
    expect(await t.run({ chat: CHAT, id: MESSAGE_ID, text: NEW_TEXT })).toMatchObject({ id: MESSAGE_ID })
  })

  test.each([
    ["a photo with a caption", { MediaType: "image", Text: "", MediaCaption: CURRENT_TEXT }],
    ["a file", { MediaType: "document", Text: "", DisplayText: "report.pdf", Filename: "report.pdf" }],
    ["a vote on a poll", { Text: "Poll vote" }],
  ])("is invalid_argument when it is %s, since only text is edited", async (_what, change) => {
    const error = await refused([ownMessageRow(change)])
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("Only text messages")
  })

  test("is invalid_argument when it is a poll", async () => {
    const poll = ownMessageRow({ Text: "Poll: Lunch?" })
    const error = await refused([poll], {}, [{ chat_jid: CHAT, msg_id: MESSAGE_ID, question: "Lunch?" }])
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("Only text messages")
  })

  test("is edited when it only reads like a poll, since wacli's list of polls does not hold it", async () => {
    await t.serve({
      mirror: { chats: [wacliChat({ jid: CHAT })], messages: [ownMessageRow({ Text: "Poll: not really" })], polls: [] },
    })
    expect(await t.run({ chat: CHAT, id: MESSAGE_ID, text: NEW_TEXT })).toMatchObject({ id: MESSAGE_ID })
  })

  test.each([
    ["equal to the current text", NEW_TEXT],
    ["equal to the current text once trimmed", `  ${NEW_TEXT}\n`],
  ])("is invalid_argument when the new text is %s", async (_what, text) => {
    const error = await refused([ownMessageRow({ Text: NEW_TEXT })], { text })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("same as the current one")
  })
})
