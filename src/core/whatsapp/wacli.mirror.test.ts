import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetWacliCache, runWacli } from "./wacli"
import { envelope, failure, installFakeWacli, pathsIn, type FakeMirror, type FakeWacli } from "./wacli.testing"

let fake: FakeWacli

beforeEach(async () => {
  resetWacliCache()
  fake = await installFakeWacli()
})

afterEach(async () => {
  await fake.cleanup()
})

const message = (id: string, chat: string, timestamp: string) => ({ MsgID: id, ChatJID: chat, Timestamp: timestamp })

function ask(...args: string[]): Promise<any> {
  return runWacli(pathsIn(fake.dir), args, { env: fake.env, mode: "read" })
}

const MIRROR: FakeMirror = {
  chats: [
    { jid: "a@s.whatsapp.net", name: "Ann", pinned: false, unread: true, last_message_ts: "2026-11-07T05:00:09Z" },
    { jid: "b@s.whatsapp.net", name: "Bo", pinned: true, unread: false, last_message_ts: "2026-11-07T05:00:01Z" },
    { jid: "c@g.us", name: "Crew", pinned: false, unread: false, last_message_ts: "2026-11-07T05:00:05Z" },
  ],
  messages: [
    message("m1", "a@s.whatsapp.net", "2026-11-07T05:00:01Z"),
    message("m2", "a@s.whatsapp.net", "2026-11-07T05:00:03Z"),
    message("m3", "a@s.whatsapp.net", "2026-11-07T05:00:03Z"),
    message("m4", "a@s.whatsapp.net", "2026-11-07T05:00:05Z"),
    message("x1", "c@g.us", "2026-11-07T05:00:04Z"),
  ],
  polls: [
    { chat_jid: "a@s.whatsapp.net", msg_id: "p1", question: "?" },
    { chat_jid: "c@g.us", msg_id: "p2", question: "!" },
  ],
  calls: [
    { chat_jid: "a@s.whatsapp.net", msg_id: "k1", timestamp: "2026-11-07T05:00:02Z" },
    { chat_jid: "a@s.whatsapp.net", msg_id: "k2", timestamp: "2026-11-07T05:00:06Z" },
  ],
}

const ids = (data: { messages: { MsgID: string }[] | null }) => data.messages?.map((row) => row.MsgID)

describe("the fake wacli's mirror", () => {
  beforeEach(() => fake.setMirror(MIRROR))

  test("lists chats pinned first, then by last message, filtered by query and unread", async () => {
    expect((await ask("chats", "list")).map((chat: { jid: string }) => chat.jid)).toEqual([
      "b@s.whatsapp.net",
      "a@s.whatsapp.net",
      "c@g.us",
    ])
    expect((await ask("chats", "list", "--query=CR")).map((chat: { name: string }) => chat.name)).toEqual(["Crew"])
    expect(
      (await ask("chats", "list", "--query", "s.whatsapp", "--unread")).map((chat: { jid: string }) => chat.jid),
    ).toEqual(["a@s.whatsapp.net"])
    expect(await ask("chats", "list", "--query=zzz")).toBeNull()
    expect(await ask("chats", "list", "--limit", "1")).toHaveLength(1)
  })

  test("shows one chat, and fails as wacli does for a missing one", async () => {
    expect((await ask("chats", "show", "--jid", "c@g.us")).name).toBe("Crew")
    await expect(ask("chats", "show", "--jid", "d@g.us")).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("no rows in result set"),
    })
  })

  test("lists messages newest first, by second and then by arrival, or oldest first with --asc", async () => {
    expect(ids(await ask("messages", "list", "--chat", "a@s.whatsapp.net"))).toEqual(["m4", "m3", "m2", "m1"])
    expect(ids(await ask("messages", "list", "--chat", "a@s.whatsapp.net", "--asc"))).toEqual(["m1", "m2", "m3", "m4"])
    expect(ids(await ask("messages", "list", "--chat", "c@g.us"))).toEqual(["x1"])
    expect(ids(await ask("messages", "list", "--chat", "a@s.whatsapp.net", "--limit", "2"))).toEqual(["m4", "m3"])
  })

  test("bounds messages exclusively in whole seconds, and says null for none", async () => {
    const chat = ["--chat", "a@s.whatsapp.net"]
    expect(ids(await ask("messages", "list", ...chat, "--after", "2026-11-07T05:00:01Z"))).toEqual(["m4", "m3", "m2"])
    expect(ids(await ask("messages", "list", ...chat, "--before", "2026-11-07T05:00:05Z"))).toEqual(["m3", "m2", "m1"])
    const none = await ask("messages", "list", ...chat, "--after", "2026-11-07T05:00:05Z")
    expect(none.messages).toBeNull()
    expect(none.page).toEqual({ has_more: false, next_cursor: null })
  })

  test("lists the polls of a chat, every one for a limit of 0, and the calls in a window", async () => {
    expect((await ask("polls", "list", "--chat", "a@s.whatsapp.net", "--limit", "0")).polls).toHaveLength(1)
    expect((await ask("polls", "list", "--limit", "0")).polls).toHaveLength(2)
    const window = ["--chat", "a@s.whatsapp.net", "--after", "2026-11-07T05:00:01Z", "--before", "2026-11-07T05:00:05Z"]
    expect((await ask("calls", "list", ...window)).calls.map((call: { msg_id: string }) => call.msg_id)).toEqual(["k1"])
    expect((await ask("calls", "list", "--chat", "c@g.us")).calls).toBeNull()
  })

  describe("search and context", () => {
    const text = (id: string, chat: string, timestamp: string, Text: string, more = {}) => ({
      ...message(id, chat, timestamp),
      Text,
      ...more,
    })
    const rows = [
      text("s1", "a@s.whatsapp.net", "2026-11-07T05:00:01Z", "Red apple"),
      text("s2", "a@s.whatsapp.net", "2026-11-07T05:00:02Z", "green APPLE pie"),
      text("s3", "c@g.us", "2026-11-07T05:00:02Z", "no fruit", { MediaCaption: "apple tree" }),
      text("s4", "a@s.whatsapp.net", "2026-11-07T05:00:03Z", "apple", { deleted_at: "2026-11-07T06:00:00Z" }),
      text("s5", "a@s.whatsapp.net", "2026-11-07T05:00:04Z", "-v flag"),
    ]
    beforeEach(() => fake.setMirror({ ...MIRROR, messages: rows }))

    test("searches like wacli's LIKE: the whole query, any case, newest first, deleted rows left out", async () => {
      const found = await ask("messages", "search", "--limit", "2", "--", "apple")
      expect(ids(found)).toEqual(["s3", "s2"])
      expect(found).toMatchObject({ fts: false, page: { has_more: true, next_cursor: null } })
      expect(ids(await ask("messages", "search", "--chat", "a@s.whatsapp.net", "--", "APPLE"))).toEqual(["s2", "s1"])
      expect(ids(await ask("messages", "search", "--after", "2026-11-07T05:00:01Z", "--", "apple"))).toEqual([
        "s3",
        "s2",
      ])
      expect((await ask("messages", "search", "--", "apple green")).messages).toBeNull()
      expect(ids(await ask("messages", "search", "--", "-v"))).toEqual(["s5"])
      expect(
        (await ask("messages", "search", "--", "Crew")).messages.map((row: { MsgID: string }) => row.MsgID),
      ).toEqual(["s3"])
    })

    test("answers as the full-text search with a relevance order: every word, best match first, fts true", async () => {
      fake.setMirror({ ...MIRROR, messages: rows, relevance: ["s2", "s1"] })
      const found = await ask("messages", "search", "--", "APPLE red")
      expect(ids(found)).toEqual(["s1"])
      const ranked = await ask("messages", "search", "--limit", "2", "--", "apple")
      expect(ids(ranked)).toEqual(["s2", "s1"])
      expect(ranked).toMatchObject({ fts: true, page: { has_more: true } })
    })

    test("gives the rows around a message oldest first, and fails as wacli does for a missing one", async () => {
      const context = (id: string, before: string, after: string) =>
        ask("messages", "context", "--chat", "a@s.whatsapp.net", `--id=${id}`, "--before", before, "--after", after)
      expect((await context("s2", "5", "5")).map((row: { MsgID: string }) => row.MsgID)).toEqual([
        "s1",
        "s2",
        "s4",
        "s5",
      ])
      expect((await context("s2", "0", "1")).map((row: { MsgID: string }) => row.MsgID)).toEqual(["s2", "s4"])
      await expect(context("s3", "1", "1")).rejects.toMatchObject({
        message: expect.stringContaining("no rows in result set"),
      })
    })
  })

  test("a response that matches wins over the mirror, and other commands are left to it", async () => {
    fake.setResponses([
      { args: ["chats", "list"], stdout: envelope([]) },
      { args: ["doctor"], stderr: failure("no"), exit: 1 },
    ])
    expect(await ask("chats", "list")).toEqual([])
    expect((await ask("chats", "show", "--jid", "c@g.us")).name).toBe("Crew")
    fake.setMirror({})
    await expect(ask("chats", "show", "--jid", "c@g.us")).rejects.toMatchObject({ code: "upstream_error" })
  })
})
