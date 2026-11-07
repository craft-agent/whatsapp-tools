import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RESULT_BUDGET } from "../pages"
import { MAX_NAME_LENGTH, capName, chatNameFields } from "./names"
import { ALICE, TEAM, at, createChatFixture, wacliChat, type ChatFixture } from "./read.testing"

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const HUGE = 100_000

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
})

afterEach(async () => {
  await t.close()
})

const size = (result: unknown) => JSON.stringify(result).length

describe("capName", () => {
  test("keeps a name of the most characters whole, and says nothing", () => {
    expect(capName("n".repeat(MAX_NAME_LENGTH))).toEqual({ text: "n".repeat(MAX_NAME_LENGTH), cut: false })
    const emoji = "😀".repeat(MAX_NAME_LENGTH)
    expect(capName(emoji)).toEqual({ text: emoji, cut: false })
  })

  test("cuts after the most characters, counted by code point, never inside a pair", () => {
    const cut = capName(`${"a".repeat(MAX_NAME_LENGTH - 1)}😀😀tail`)
    expect(cut.cut).toBe(true)
    expect(cut.text).toBe(`${"a".repeat(MAX_NAME_LENGTH - 1)}😀`)
    expect(LONE_SURROGATE.test(cut.text)).toBe(false)
    expect(capName("n".repeat(MAX_NAME_LENGTH + 1))).toEqual({ text: "n".repeat(MAX_NAME_LENGTH), cut: true })
  })

  test("a chat name is trimmed first, and null when nothing is left", () => {
    expect(chatNameFields("  Alice ")).toEqual({ name: "Alice" })
    expect(chatNameFields(" ")).toEqual({ name: null })
    expect(chatNameFields("x".repeat(HUGE))).toEqual({ name: "x".repeat(MAX_NAME_LENGTH), name_cut: true })
  })
})

describe("chat read: names the people chose", () => {
  test("a huge chat name is cut in a view, whose empty page and header stay far under the budget", async () => {
    t.addChats(wacliChat({ jid: ALICE, name: `${"T".repeat(MAX_NAME_LENGTH - 1)}😀${"t".repeat(HUGE)}` }))
    const result = await t.read({ method: "view", chat: ALICE })
    expect(result.messages).toEqual([])
    expect(result.chat?.name).toBe(`${"T".repeat(MAX_NAME_LENGTH - 1)}😀`)
    expect(result.chat?.name_cut).toBe(true)
    expect(LONE_SURROGATE.test(JSON.stringify(result))).toBe(false)
    expect(size(result)).toBeLessThan(2000)
  })

  test("a huge chat name is cut in a list, and a name of the most characters is not", async () => {
    t.addChats(
      wacliChat({ jid: ALICE, name: "N".repeat(HUGE) }),
      wacliChat({ jid: TEAM, kind: "group", name: "G".repeat(MAX_NAME_LENGTH) }),
    )
    const chats = new Map(((await t.read({ method: "list" })).chats ?? []).map((chat) => [chat.id, chat]))
    expect(chats.get(ALICE)).toMatchObject({ name: "N".repeat(MAX_NAME_LENGTH), name_cut: true })
    expect(chats.get(TEAM)?.name).toBe("G".repeat(MAX_NAME_LENGTH))
    expect(chats.get(TEAM)).not.toHaveProperty("name_cut")
  })

  test("a huge sender name is cut and says so, and the user's own messages say nothing of it", async () => {
    t.addChats(wacliChat({ jid: TEAM, kind: "group", name: "Team" }))
    t.add(
      { id: "g1", chat: TEAM, at: at(0), Text: "hi", SenderName: "S".repeat(HUGE) },
      { id: "g2", chat: TEAM, at: at(1), Text: "mine", FromMe: true, SenderName: "S".repeat(HUGE) },
      { id: "g3", chat: TEAM, at: at(2), Text: "ok", SenderName: "S".repeat(MAX_NAME_LENGTH) },
    )
    const [first, mine, whole] = (await t.read({ method: "view", chat: TEAM })).messages ?? []
    expect(first).toMatchObject({ from: "S".repeat(MAX_NAME_LENGTH), from_cut: true })
    expect(mine?.from).toBe("me")
    expect(mine).not.toHaveProperty("from_cut")
    expect(whole).not.toHaveProperty("from_cut")
  })

  test("a huge file name is cut and says so", async () => {
    t.addChats(wacliChat({ jid: ALICE, name: "Alice" }))
    t.add({ id: "m1", at: at(0), DisplayText: "Sent document", MediaType: "document", Filename: "f".repeat(HUGE) })
    const [message] = (await t.read({ method: "view", chat: ALICE })).messages ?? []
    expect(message?.media).toEqual({ kind: "document", name: "f".repeat(MAX_NAME_LENGTH), name_cut: true })
  })

  test("a page of messages with the longest names still stays under the budget", async () => {
    t.addChats(wacliChat({ jid: TEAM, kind: "group", name: "G".repeat(HUGE) }))
    t.add(
      ...Array.from({ length: 300 }, (_, n) => ({
        id: `g${n}`,
        chat: TEAM,
        at: at(n),
        DisplayText: "Sent document",
        MediaType: "document",
        Filename: "f".repeat(HUGE),
        SenderName: "S".repeat(HUGE),
      })),
    )
    const pages = await t.pages(TEAM, { limit: 300 })
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(size(page)).toBeLessThan(RESULT_BUDGET)
    expect(new Set(t.ids(pages)).size).toBe(300)
  })

  test("a list of chats with the longest names and last messages stays under the budget", async () => {
    const jids = Array.from({ length: 60 }, (_, n) => `1666010${String(n).padStart(4, "0")}@s.whatsapp.net`)
    t.addChats(
      ...jids.map((jid, n) =>
        wacliChat({ jid, name: "N".repeat(HUGE), last_message_ts: new Date(at(n)).toISOString() }),
      ),
    )
    t.add(
      ...jids.map((chat, n) => ({
        id: `m${n}`,
        chat,
        at: at(n),
        Text: "w".repeat(2000),
        SenderName: "S".repeat(HUGE),
      })),
    )
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await t.read({ method: "list", last: true, limit: 200, ...(cursor ? { cursor } : {}) })
      expect(size(page)).toBeLessThan(RESULT_BUDGET)
      seen.push(...(page.chats ?? []).map((chat) => chat.id))
      cursor = page.next
    } while (cursor)
    expect(seen).toEqual([...jids].reverse())
  }, 60_000)
})
