import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RESULT_BUDGET } from "../pages"
import { ALICE, at, createChatFixture, wacliChat, type ChatFixture } from "./read.testing"

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(wacliChat({ jid: ALICE, name: "Alice" }))
})

afterEach(async () => {
  await t.close()
})

const size = (result: unknown) => JSON.stringify(result).length

describe("chat read: the size of a result", () => {
  test("many long messages come back as fewer items and a next, and the pages cover them all", async () => {
    const sent = Array.from({ length: 60 }, (_, n) => `m${n} ${"x".repeat(2000)}`)
    t.add(...sent.map((Text, n) => ({ id: `m${n}`, at: at(n), Text })))
    const pages = await t.pages(ALICE)
    for (const page of pages) {
      expect(size(page)).toBeLessThan(RESULT_BUDGET)
      expect(page.messages?.length).toBeLessThan(50)
    }
    expect(pages.length).toBeGreaterThan(2)
    expect(
      pages
        .slice()
        .reverse()
        .flatMap((page) => page.messages?.map((message) => message.text)),
    ).toEqual(sent)
  })

  test("a page the budget stopped counts the unreadable rows it passed once, across pages", async () => {
    const rows = Array.from({ length: 40 }, (_, n) => [
      { id: `m${n}`, at: at(Math.floor(n / 2)), Text: `m${n} ${"y".repeat(3000)}` },
      { id: `u${n}`, at: at(Math.floor(n / 2)) },
    ]).flat()
    t.add(...rows)
    const pages = await t.pages(ALICE)
    expect(pages.length).toBeGreaterThan(2)
    for (const page of pages) expect(size(page)).toBeLessThan(RESULT_BUDGET)
    const seen = t.ids(pages)
    expect(new Set(seen).size).toBe(40)
    expect([...seen].sort()).toEqual(Array.from({ length: 40 }, (_, n) => `m${n}`).sort())
    expect(pages.reduce((total, page) => total + (page.unreadable_rows ?? 0), 0)).toBe(40)
  })

  test("text is never cut while the messages fit in a result, however long", async () => {
    const long = "y".repeat(10_000)
    t.add({ id: "m1", at: at(0), Text: long }, { id: "m2", at: at(1), Text: "short" })
    const messages = (await t.read({ method: "view", chat: ALICE })).messages ?? []
    expect(messages.map((message) => message.text)).toEqual([long, "short"])
    expect(messages.some((message) => "text_cut" in message)).toBe(false)
  })

  test("a message that alone exceeds the budget has its text cut to fit and says so", async () => {
    const long = `${'Ünï"\n🙂'.repeat(30_000)}`
    t.add({ id: "m1", at: at(0), Text: "older" }, { id: "m2", at: at(1), Text: long })
    const result = await t.read({ method: "view", chat: ALICE, limit: 1 })
    expect(result.messages).toHaveLength(1)
    const [message] = result.messages ?? []
    expect(message?.text_cut).toBe(true)
    expect(long.startsWith(message?.text ?? "x")).toBe(true)
    expect(message?.text?.length).toBeGreaterThan(1000)
    expect(LONE_SURROGATE.test(message?.text ?? "")).toBe(false)
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
    expect(result.next).toBeDefined()
    const older = await t.read({ method: "view", chat: ALICE, cursor: result.next })
    expect(older.messages?.map((entry) => entry.text)).toEqual(["older"])
  })

  test("an oversized message cuts its quote and caption only after its text", async () => {
    t.add({
      id: "m1",
      at: at(0),
      Text: "z".repeat(10),
      DisplayText: `> ${"q".repeat(60_000)}\n${"z".repeat(10)}`,
      quoted_msg_id: "q1",
      MediaType: "image",
      MediaCaption: "c".repeat(100),
    })
    const [message] = (await t.read({ method: "view", chat: ALICE })).messages ?? []
    expect(message?.text).toBe("z".repeat(10))
    expect(message?.media?.caption).toBe("c".repeat(100))
    expect(message?.reply_to?.text?.length).toBeLessThan(60_000)
    expect(message?.text_cut).toBe(true)
  })

  test("a list with long last messages returns fewer chats and a next that continues", async () => {
    const people = Array.from({ length: 30 }, (_, n) => `155501002${String(n).padStart(2, "0")}@s.whatsapp.net`)
    t.addChats(...people.map((jid, n) => wacliChat({ jid, last_message_ts: new Date(at(n)).toISOString() })))
    t.add(...people.map((chat, n) => ({ id: `m${n}`, chat, at: at(n), Text: "w".repeat(5000) })))
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const result = await t.read({ method: "list", last: true, limit: 200, ...(cursor ? { cursor } : {}) })
      expect(size(result)).toBeLessThan(RESULT_BUDGET)
      expect(result.chats?.length).toBeLessThan(30)
      seen.push(...(result.chats ?? []).map((chat) => chat.id))
      cursor = result.next
    } while (cursor)
    expect(seen.filter((id) => people.includes(id))).toEqual([...people].reverse())
  }, 60_000)

  test("a chat whose last message alone exceeds the budget is cut in the list", async () => {
    t.add({ id: "m1", at: at(0), Text: "v".repeat(80_000) })
    const result = await t.read({ method: "list", last: true })
    expect(result.chats?.[0]?.last_message?.text_cut).toBe(true)
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
  })
})
