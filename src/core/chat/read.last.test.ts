import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { formatLocalTime } from "../time"
import { ALICE, BOB, TEAM, at, createChatFixture, wacliChat, type ChatFixture } from "./read.testing"

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(
    wacliChat({ jid: ALICE, name: "Alice", last_message_ts: new Date(at(30)).toISOString() }),
    wacliChat({ jid: BOB, name: "Bob", last_message_ts: new Date(at(20)).toISOString() }),
    wacliChat({ jid: TEAM, kind: "group", name: "Team", last_message_ts: new Date(at(10)).toISOString() }),
  )
})

afterEach(async () => {
  await t.close()
})

async function lastMessages() {
  const chats = (await t.read({ method: "list", last: true })).chats ?? []
  return new Map(chats.map((chat) => [chat.id, chat.last_message]))
}

describe("chat read: list with the last message", () => {
  test("adds each chat's newest message, and null for a chat with none", async () => {
    t.add(
      { id: "a1", at: at(1), Text: "first" },
      { id: "a2", at: at(2), Text: "second", FromMe: true },
      { id: "g1", chat: TEAM, at: at(3), Text: "hi team" },
    )
    const last = await lastMessages()
    expect(last.get(ALICE)).toEqual({ id: "a2", time: formatLocalTime(at(2)), from: "me", text: "second" })
    expect(last.get(TEAM)).toMatchObject({ id: "g1", text: "hi team", from_jid: BOB })
    expect(last.get(BOB)).toBeNull()
  })

  test("looks past rows wacli could not read, up to 20 rows", async () => {
    t.add(
      { id: "a1", at: at(1), Text: "real" },
      ...Array.from({ length: 19 }, (_, n) => ({ id: `u${n}`, at: at(2 + n) })),
      { id: "b1", chat: BOB, at: at(1), Text: "too deep" },
      ...Array.from({ length: 20 }, (_, n) => ({ id: `v${n}`, chat: BOB, at: at(2 + n) })),
    )
    const last = await lastMessages()
    expect(last.get(ALICE)).toMatchObject({ id: "a1", text: "real" })
    expect(last.get(BOB)).toBeNull()
  })

  test("marks a last message that is a poll, as view does", async () => {
    t.mirror.polls.push({ chat_jid: ALICE, msg_id: "p1", question: "Lunch?" })
    t.add({ id: "p1", at: at(1), Text: "Poll: Lunch?" })
    expect((await lastMessages()).get(ALICE)).toMatchObject({ kind: "poll", poll: { question: "Lunch?" } })
  })

  test("reads without last make no message read, and with last one per chat in the page", async () => {
    t.add({ id: "a1", at: at(1), Text: "x" })
    await t.read({ method: "list" })
    const messageReads = async () =>
      (await t.fake.calls()).filter((call) => call.argv.includes("messages") && call.argv.includes("list")).length
    expect(await messageReads()).toBe(0)
    await t.read({ method: "list", last: true, limit: 2 })
    expect(await messageReads()).toBe(2)
  })
})
