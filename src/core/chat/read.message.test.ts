import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { formatLocalTime } from "../time"
import { ALICE, BOB, TEAM, at, createChatFixture, wacliChat, type ChatFixture, type MessageInit } from "./read.testing"

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: TEAM, kind: "group", name: "Team" }))
})

afterEach(async () => {
  await t.close()
})

/** The one message of the chat of Alice (or of `chat`) that a test added, as the tool returns it. */
async function only(init: MessageInit) {
  t.add(init)
  const messages = (await t.read({ method: "view", chat: init.chat ?? ALICE })).messages ?? []
  expect(messages).toHaveLength(1)
  return messages[0]!
}

describe("chat read: a message", () => {
  test("holds only what is set, never a null for a field that is absent", async () => {
    expect(await only({ id: "m1", at: at(0), Text: "hello" })).toEqual({
      id: "m1",
      time: formatLocalTime(at(0)),
      from: null,
      from_jid: ALICE,
      text: "hello",
    })
  })

  test("is from me, or from the sender by name and JID", async () => {
    expect(await only({ id: "m1", at: at(0), Text: "mine", FromMe: true })).toEqual({
      id: "m1",
      time: formatLocalTime(at(0)),
      from: "me",
      text: "mine",
    })
    expect(
      await only({ id: "g1", chat: TEAM, at: at(0), Text: "hi", SenderName: " Bob ", SenderJID: BOB }),
    ).toMatchObject({ id: "g1", from: "Bob", from_jid: BOB })
  })

  test("falls back to the chat's JID for a sender wacli has none for, in a chat with one person only", async () => {
    expect(await only({ id: "m1", at: at(0), Text: "hi", SenderJID: "" })).toMatchObject({ from_jid: ALICE })
    const group = await only({ id: "g1", chat: TEAM, at: at(0), Text: "hi", SenderJID: "" })
    expect(group).toMatchObject({ id: "g1", from: null })
    expect(group).not.toHaveProperty("from_jid")
  })

  test("names its media by kind, file name, type and caption, and never carries a path", async () => {
    const message = await only({
      id: "m1",
      at: at(0),
      DisplayText: "Sent image",
      MediaType: "image",
      MediaCaption: "look",
      Filename: "cat.jpg",
      MimeType: "image/jpeg",
    })
    expect(message).toEqual({
      id: "m1",
      time: formatLocalTime(at(0)),
      from: null,
      from_jid: ALICE,
      media: { kind: "image", name: "cat.jpg", mime: "image/jpeg", caption: "look" },
    })
    const json = JSON.stringify(await t.read({ method: "view", chat: ALICE }))
    for (const hidden of ["private-direct-path", "private-local-path", "DirectPath", "LocalPath", t.stateDir]) {
      expect(json).not.toContain(hidden)
    }
  })

  test("a bare media kind has no name, type or caption", async () => {
    expect((await only({ id: "m1", at: at(0), DisplayText: "Sent audio", MediaType: "audio" })).media).toEqual({
      kind: "audio",
    })
  })

  test("marks what was edited, forwarded and starred", async () => {
    expect(
      await only({ id: "m1", at: at(0), Text: "x", Edited: true, IsForwarded: true, Starred: true }),
    ).toMatchObject({ edited: true, forwarded: true, starred: true })
  })

  test("a deleted message says so and keeps no text", async () => {
    const message = await only({
      id: "m1",
      at: at(0),
      Text: "secret",
      Revoked: true,
      DisplayText: "This message was deleted",
    })
    expect(message).toMatchObject({ id: "m1", deleted: true })
    expect(message).not.toHaveProperty("text")
    expect(JSON.stringify(message)).not.toContain("secret")
  })

  test("a reaction is an entry of its own, with its emoji and the message it reacts to", async () => {
    t.add(
      { id: "m1", at: at(0), Text: "hello" },
      { id: "r1", at: at(1), ReactionToID: "m1", ReactionEmoji: "👍", DisplayText: "Reacted 👍 to hello" },
      { id: "r2", at: at(2), ReactionToID: "m1", ReactionEmoji: "", DisplayText: "Reacted to hello" },
    )
    const [, reaction, taken] = (await t.read({ method: "view", chat: ALICE })).messages ?? []
    expect(reaction).toMatchObject({ id: "r1", reaction: { emoji: "👍", to: "m1" } })
    expect(reaction).not.toHaveProperty("text")
    expect(taken?.reaction).toEqual({ emoji: null, to: "m1" })
  })
})

describe("chat read: a reply", () => {
  const reply = (init: Partial<MessageInit> & { DisplayText: string }) =>
    only({ id: "m1", at: at(0), quoted_msg_id: "q1", ...init })

  test("carries the quoted message's id, sender and text", async () => {
    const message = await reply({ Text: "yes", DisplayText: "> are you coming?\nyes", quoted_sender_jid: BOB })
    expect(message.reply_to).toEqual({ id: "q1", from_jid: BOB, text: "are you coming?" })
    expect(message.text).toBe("yes")
  })

  test("takes a quote and a reply of several lines apart by the reply's own text", async () => {
    const message = await reply({ Text: "one\ntwo", DisplayText: "> a\nb\nc\none\ntwo" })
    expect(message.reply_to?.text).toBe("a\nb\nc")
  })

  test("reads a quote of several lines over a reply with a line of its own", async () => {
    const message = await reply({ DisplayText: "> a\nb\nSent image", MediaType: "image" })
    expect(message.reply_to).toEqual({ id: "q1", text: "a\nb" })
    expect(message.media).toEqual({ kind: "image" })
  })

  test("knows no text when wacli did not have the quoted message", async () => {
    expect((await reply({ Text: "yes", DisplayText: "> message\nyes" })).reply_to).toEqual({ id: "q1", text: null })
  })

  test("a reply with nothing but its quote has no text", async () => {
    const message = await reply({ DisplayText: "> hello\n(message)" })
    expect(message.reply_to?.text).toBe("hello")
    expect(message).not.toHaveProperty("text")
  })

  test("a display text without a quote gives a null text, and an id alone is a reply still", async () => {
    expect((await reply({ Text: "yes", DisplayText: "yes" })).reply_to).toEqual({ id: "q1", text: null })
  })
})

describe("chat read: polls, votes and calls", () => {
  test("a poll is marked by wacli's own list of polls, with its question", async () => {
    t.mirror.polls.push({ chat_jid: ALICE, msg_id: "p1", question: "Lunch?", options: ["a", "b"] })
    const message = await only({ id: "p1", at: at(0), Text: "Poll: Lunch?" })
    expect(message).toMatchObject({ kind: "poll", poll: { question: "Lunch?" }, text: "Poll: Lunch?" })
    expect(JSON.stringify(message)).not.toContain("options")
  })

  test("text that merely reads like a poll or a call is a plain message", async () => {
    t.add(
      { id: "p1", at: at(0), Text: "Poll: Lunch?" },
      { id: "c1", at: at(1), DisplayText: "WhatsApp audio call connected" },
    )
    const messages = (await t.read({ method: "view", chat: ALICE })).messages ?? []
    expect(messages.map((message) => message.kind)).toEqual([undefined, undefined])
    expect(messages.map((message) => message.id)).toEqual(["p1", "c1"])
  })

  test("a vote and an added option are marked by wacli's fixed text", async () => {
    t.add(
      { id: "v1", at: at(0), Text: "Poll vote" },
      { id: "o1", at: at(1), Text: "Poll option added" },
      { id: "i1", at: at(2), Text: "Poll vote", MediaType: "image" },
    )
    const messages = (await t.read({ method: "view", chat: ALICE })).messages ?? []
    expect(messages.map((message) => message.kind)).toEqual(["poll_vote", "poll_option_added", undefined])
  })

  test("a call is marked by wacli's list of calls, with what wacli says of it", async () => {
    t.mirror.calls.push({
      chat_jid: ALICE,
      msg_id: "c1",
      call_id: "call-1",
      event_type: "call_log",
      timestamp: new Date(at(0)).toISOString(),
    })
    const message = await only({ id: "c1", at: at(0), DisplayText: "WhatsApp audio call connected (1m01s)" })
    expect(message).toMatchObject({ kind: "call", call: { description: "WhatsApp audio call connected (1m01s)" } })
    expect(message).not.toHaveProperty("text")
  })

  test("a call row wacli holds no event for is a plain message, and only calls are asked about", async () => {
    t.mirror.calls.push({ chat_jid: ALICE, msg_id: "far", timestamp: new Date(at(500)).toISOString() })
    t.add({ id: "c1", at: at(0), DisplayText: "WhatsApp video call missed" }, { id: "m1", at: at(1), Text: "hi" })
    const messages = (await t.read({ method: "view", chat: ALICE })).messages ?? []
    expect(messages[0]?.kind).toBeUndefined()
    const asked = (await t.fake.calls()).filter((call) => ["polls", "calls"].includes(call.argv[4] ?? ""))
    expect(asked.map((call) => call.argv[4])).toEqual(["calls"])
    expect(asked[0]?.argv).toContain("--chat")
  })

  test("a page with no poll or call asks for neither", async () => {
    t.add({ id: "m1", at: at(0), Text: "hi" })
    await t.read({ method: "view", chat: ALICE })
    const asked = (await t.fake.calls()).filter((call) => ["polls", "calls"].includes(call.argv[4] ?? ""))
    expect(asked).toEqual([])
  })
})
