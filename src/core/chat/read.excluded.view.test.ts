import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { decodeCursor } from "../pages"
import { envelope } from "../whatsapp/wacli.testing"
import { SCAN_LIMIT } from "./scan"
import { ALICE, BOB, HIDDEN, at, createChatFixture, wacliChat, wacliMessage, type ChatFixture } from "./read.testing"

const NO_MESSAGE = "No message with this id in this chat."

/** The time a test that fills the mirror past the scan limit may take: every wacli call reads a mirror of that size. */
const SLOW_TEST_MS = 60_000

let t: ChatFixture

/** Alice's phone JID is excluded; her …@lid is not, and wacli covers one with the other. */
beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: BOB, name: "Bob" }), wacliChat({ jid: HIDDEN }))
  t.mirror.aliases = [[ALICE, HIDDEN]]
  t.exclude(ALICE)
})

afterEach(async () => {
  await t.close()
})

const idsOf = (page: { messages?: { id: string }[] }) => page.messages?.map((message) => message.id)

describe("chat read: view of a chat that wacli covers with an excluded JID of the same person", () => {
  test("leaves out the rows filed under the excluded JID, and counts none of them as unreadable", async () => {
    t.add(
      { id: "h1", chat: HIDDEN, at: at(1), Text: "allowed" },
      { id: "a1", chat: ALICE, at: at(2), Text: "secret" },
      { id: "a2", chat: ALICE, at: at(3) },
      { id: "h2", chat: HIDDEN, at: at(4), Text: "allowed too" },
      { id: "h3", chat: HIDDEN, at: at(5) },
    )
    const result = await t.read({ method: "view", chat: HIDDEN })
    expect(idsOf(result)).toEqual(["h1", "h2"])
    expect(result.unreadable_rows).toBe(1)
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("pages past a run of excluded rows at a page boundary, neither stalling nor showing one", async () => {
    t.add(
      { id: "h1", chat: HIDDEN, at: at(1), Text: "x" },
      ...Array.from({ length: 5 }, (_, n) => ({ id: `a${n}`, chat: ALICE, at: at(2 + n), Text: "secret" })),
      { id: "h2", chat: HIDDEN, at: at(8), Text: "x" },
      { id: "h3", chat: HIDDEN, at: at(9), Text: "x" },
    )
    const pages = await t.pages(HIDDEN, { limit: 1 })
    expect(pages.map(idsOf)).toEqual([["h3"], ["h2"], ["h1"]])
    expect(pages.every((page) => page.unreadable_rows === undefined)).toBe(true)
  })

  test("pages past a run of excluded rows among rows of one second", async () => {
    t.add(
      { id: "h1", chat: HIDDEN, at: at(5), Text: "x" },
      { id: "a1", chat: ALICE, at: at(5), Text: "secret" },
      { id: "a2", chat: ALICE, at: at(5), Text: "secret" },
      { id: "h2", chat: HIDDEN, at: at(5), Text: "x" },
    )
    const pages = await t.pages(HIDDEN, { limit: 1 })
    expect(new Set(pages.flatMap((page) => idsOf(page) ?? []))).toEqual(new Set(["h1", "h2"]))
    expect(pages).toHaveLength(2)
  })

  test(
    "a page that looked through the scan limit of excluded rows shows none and continues from where it stopped",
    async () => {
      t.add(
        { id: "h1", chat: HIDDEN, at: at(0), Text: "x" },
        ...Array.from({ length: SCAN_LIMIT + 5 }, (_, n) => ({
          id: `a${n}`,
          chat: ALICE,
          at: at(1 + n),
          Text: "secret",
        })),
      )
      const pages = await t.pages(HIDDEN, { limit: 5 })
      expect(pages.length).toBeGreaterThan(1)
      expect(pages.flatMap((page) => idsOf(page) ?? [])).toEqual(["h1"])
      expect(pages.every((page) => page.unreadable_rows === undefined)).toBe(true)
    },
    SLOW_TEST_MS,
  )

  test("refuses a cursor taken under another setting, and a cursor carries no excluded JID", async () => {
    t.add(
      { id: "h1", chat: HIDDEN, at: at(1), Text: "x" },
      { id: "h2", chat: HIDDEN, at: at(2), Text: "x" },
      { id: "h3", chat: HIDDEN, at: at(3), Text: "x" },
    )
    const first = await t.read({ method: "view", chat: HIDDEN, limit: 1 })
    const cursor = JSON.stringify(decodeCursor(first.next!, "cursor"))
    expect(cursor).not.toContain(ALICE)
    expect(cursor).not.toContain("15550100001")
    expect(idsOf(await t.read({ method: "view", chat: HIDDEN, limit: 1, cursor: first.next }))).toEqual(["h2"])

    t.exclude(ALICE, BOB)
    const error = await t.failure({ method: "view", chat: HIDDEN, limit: 1, cursor: first.next })
    expect(error.message).toBe("cursor is not a cursor this tool returned.")
  })

  test("attaches no poll or call of the excluded chat to a row of the allowed one", async () => {
    t.mirror.polls.push(
      { chat_jid: ALICE, msg_id: "p1", question: "secret question?" },
      { chat_jid: HIDDEN, msg_id: "p2", question: "open question?" },
    )
    t.mirror.calls.push({ chat_jid: ALICE, msg_id: "c1", timestamp: new Date(at(2)).toISOString() })
    t.add(
      { id: "p1", chat: HIDDEN, at: at(1), Text: "Poll: secret question?" },
      { id: "p2", chat: HIDDEN, at: at(1), Text: "Poll: open question?" },
      { id: "c1", chat: HIDDEN, at: at(2), DisplayText: "WhatsApp audio call connected (1m01s)" },
    )
    const messages = (await t.read({ method: "view", chat: HIDDEN })).messages ?? []
    const byId = new Map(messages.map((message) => [message.id, message]))
    expect(byId.get("p1")?.kind).toBeUndefined()
    expect(byId.get("p1")).not.toHaveProperty("poll")
    expect(byId.get("p2")).toMatchObject({ kind: "poll", poll: { question: "open question?" } })
    expect(byId.get("c1")?.kind).toBeUndefined()
  })
})

describe("chat read: around a message of a chat that wacli covers with an excluded JID of the same person", () => {
  test("treats an anchor filed under the excluded JID as a message the chat does not hold", async () => {
    t.add({ id: "h1", chat: HIDDEN, at: at(1), Text: "before" }, { id: "a1", chat: ALICE, at: at(2), Text: "secret" })
    const missing = await t.failure({ method: "around", chat: HIDDEN, id: "nosuch" })
    const excluded = await t.failure({ method: "around", chat: HIDDEN, id: "a1" })
    expect(excluded.code).toBe("not_found")
    expect(excluded.message).toBe(NO_MESSAGE)
    expect(excluded.message).toBe(missing.message)
    expect(excluded.code).toBe(missing.code)
  })

  test("leaves out the context rows filed under the excluded JID, and counts none of them", async () => {
    const row = (id: string, chat: string, n: number, extra: Record<string, unknown> = {}) =>
      wacliMessage({ id, chat, at: at(n), Text: id, ...extra })
    t.fake.setResponses([
      {
        args: ["messages", "context"],
        stdout: envelope([
          row("h1", HIDDEN, 1),
          row("a1", ALICE, 2, { Text: "secret" }),
          row("a2", ALICE, 3, { Text: "" }),
          row("h2", HIDDEN, 4),
          row("a3", ALICE, 5, { Text: "secret" }),
          row("h3", HIDDEN, 6),
        ]),
      },
    ])
    const result = await t.read({ method: "around", chat: HIDDEN, id: "h2" })
    expect(result.anchor).toBe("h2")
    expect(idsOf(result)).toEqual(["h1", "h2", "h3"])
    expect(result.unreadable_rows).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("is unchanged when the anchor and its context are of the allowed chat", async () => {
    t.add(
      { id: "h1", chat: HIDDEN, at: at(1), Text: "before" },
      { id: "h2", chat: HIDDEN, at: at(2), Text: "anchor" },
      { id: "h3", chat: HIDDEN, at: at(3), Text: "after" },
    )
    const result = await t.read({ method: "around", chat: HIDDEN, id: "h2" })
    expect(idsOf(result)).toEqual(["h1", "h2", "h3"])
  })
})
