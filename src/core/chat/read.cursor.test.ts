import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { RESULT_BUDGET, decodeCursor } from "../pages"
import { labelPaths } from "../whatsapp/labels"
import { ALICE, at, createChatFixture, wacliChat, type ChatFixture } from "./read.testing"

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(wacliChat({ jid: ALICE, name: "Alice", last_message_ts: new Date(at(0)).toISOString() }))
})

afterEach(async () => {
  await t.close()
})

const size = (result: unknown) => JSON.stringify(result).length

describe("chat read: the cursor and the size of a result", () => {
  test("hundreds of messages of one second page within the budget, `next` included, without a gap or a repeat", async () => {
    const count = 400
    t.add(...Array.from({ length: count }, (_, n) => ({ id: `msg-${n}`, at: at(5), Text: `${n} ${"x".repeat(100)}` })))
    const pages = await t.pages(ALICE, { limit: 300 })
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(size(page)).toBeLessThan(RESULT_BUDGET)
    const seen = t.ids(pages)
    expect(seen).toHaveLength(count)
    expect(new Set(seen).size).toBe(count)
  })

  test("a cursor over one second holds a short digest per message, never the id", async () => {
    t.add(...Array.from({ length: 300 }, (_, n) => ({ id: `a-long-message-id-${n}`, at: at(5), Text: `${n}` })))
    const first = await t.read({ method: "view", chat: ALICE, limit: 250 })
    const cursor = decodeCursor(first.next!, "cursor") as { ids: string[] }
    expect(cursor.ids).toHaveLength(250)
    expect(cursor.ids.every((id) => id.length === 11)).toBe(true)
    expect(first.next!.length).toBeLessThan(250 * 20)
    expect(JSON.stringify(cursor)).not.toContain("a-long-message-id")
    const second = await t.read({ method: "view", chat: ALICE, limit: 250, cursor: first.next })
    expect(second.messages).toHaveLength(50)
    expect(second.next).toBeUndefined()
  })

  test("a page the budget stopped in the middle of one second continues in that second", async () => {
    t.add(...Array.from({ length: 30 }, (_, n) => ({ id: `m${n}`, at: at(5), Text: `m${n} ${"y".repeat(5000)}` })))
    const pages = await t.pages(ALICE)
    expect(pages.length).toBeGreaterThan(2)
    for (const page of pages) expect(size(page)).toBeLessThan(RESULT_BUDGET)
    expect(new Set(t.ids(pages)).size).toBe(30)
  })

  test("a list with a next is measured with it too", async () => {
    const jids = Array.from({ length: 200 }, (_, n) => `1666010${String(n).padStart(4, "0")}@s.whatsapp.net`)
    t.addChats(
      ...jids.map((jid, n) =>
        wacliChat({ jid, name: "N".repeat(200), last_message_ts: new Date(at(n)).toISOString() }),
      ),
    )
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await t.read({ method: "list", limit: 200, ...(cursor ? { cursor } : {}) })
      expect(size(page)).toBeLessThan(RESULT_BUDGET)
      seen.push(...(page.chats ?? []).map((chat) => chat.id))
      cursor = page.next
    } while (cursor)
    expect(seen).toHaveLength(201)
    expect(new Set(seen).size).toBe(201)
  })
})

describe("chat read: a cursor belongs to its account", () => {
  function pairSecond() {
    mkdirSync(labelPaths(t.stateDir, "second").dir)
  }

  test("a view cursor of one account is refused under another, and still works under its own", async () => {
    t.add(...Array.from({ length: 6 }, (_, n) => ({ id: `m${n}`, at: at(n), Text: `m${n}` })))
    pairSecond()
    const first = await t.read({ method: "view", chat: ALICE, limit: 2, account: "main" })
    const error = await t.failure({ method: "view", chat: ALICE, limit: 2, cursor: first.next, account: "second" })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("cursor is not a cursor this tool returned.")
    const second = await t.read({ method: "view", chat: ALICE, limit: 2, cursor: first.next, account: "main" })
    expect(second.messages?.map((message) => message.id)).toEqual(["m2", "m3"])
    const other = await t.read({ method: "view", chat: ALICE, limit: 2, account: "second" })
    expect((await t.failure({ method: "view", chat: ALICE, cursor: other.next, account: "main" })).code).toBe(
      "invalid_argument",
    )
  })

  test("a list cursor of one account is refused under another, and still works under its own", async () => {
    t.addChats(wacliChat({ jid: "15550100002@s.whatsapp.net" }), wacliChat({ jid: "15550100003@s.whatsapp.net" }))
    pairSecond()
    const first = await t.read({ method: "list", limit: 1, account: "main" })
    const error = await t.failure({ method: "list", limit: 1, cursor: first.next, account: "second" })
    expect(error.message).toBe("cursor is not a cursor this tool returned.")
    expect((await t.read({ method: "list", limit: 1, cursor: first.next, account: "main" })).chats).toHaveLength(1)
  })
})
