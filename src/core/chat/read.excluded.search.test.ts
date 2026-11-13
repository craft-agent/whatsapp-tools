import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { decodeCursor } from "../pages"
import { ALICE, BOB, HIDDEN, at, createChatFixture, wacliChat, type ChatFixture } from "./read.testing"
import { SEARCH_FETCH_CAP } from "./search"

/** The time a test that fills the mirror past the cap may take: every wacli call reads a mirror of that size. */
const SLOW_TEST_MS = 30_000

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: BOB, name: "Bob" }), wacliChat({ jid: HIDDEN }))
  t.exclude(ALICE)
})

afterEach(async () => {
  await t.close()
})

const search = (args: Record<string, unknown> = {}) => t.read({ method: "search", query: "x", ...args })

const idsOf = (page: { messages?: { id: string }[] }) => page.messages?.map((message) => message.id)

/** Every page of a search, following `next`. */
async function pages(args: Record<string, unknown> = {}) {
  const all = []
  let cursor: string | undefined
  do {
    const page = await search({ ...args, ...(cursor ? { cursor } : {}) })
    all.push(page)
    cursor = page.next
  } while (cursor)
  return all
}

describe("chat read: search with excluded chats", () => {
  test("leaves out the hits of an excluded chat, counts none of them as unreadable and looks nothing up for them", async () => {
    t.add(
      { id: "a1", chat: ALICE, at: at(1), Text: "message secret" },
      { id: "a2", chat: ALICE, at: at(2), Text: "Poll: message secret?" },
      { id: "a3", chat: ALICE, at: at(3) },
      { id: "b1", chat: BOB, at: at(4), Text: "message fine" },
      { id: "b2", chat: BOB, at: at(5) },
    )
    const result = await search({ query: "message" })
    expect(idsOf(result)).toEqual(["b1"])
    expect(result.unreadable_rows).toBe(1)
    expect(JSON.stringify(result)).not.toContain("secret")
    expect((await t.fake.calls()).filter((call) => call.argv.some((arg) => arg.includes("15550100001")))).toEqual([])
  })

  test("pages on past a run of excluded hits at a page boundary, without showing one", async () => {
    t.add(
      { id: "b1", chat: BOB, at: at(9), Text: "x" },
      ...Array.from({ length: 5 }, (_, n) => ({ id: `a${n}`, chat: ALICE, at: at(8 - n), Text: "x" })),
      { id: "b2", chat: BOB, at: at(2), Text: "x" },
      { id: "b3", chat: BOB, at: at(1), Text: "x" },
    )
    const all = await pages({ limit: 1 })
    expect(all.map(idsOf)).toEqual([["b1"], ["b2"], ["b3"]])
    expect(all.every((page) => page.unreadable_rows === undefined)).toBe(true)
  })

  test("a run of excluded hits last on the list ends it, with no empty page after the last allowed hit", async () => {
    t.add(
      { id: "b1", chat: BOB, at: at(9), Text: "x" },
      ...Array.from({ length: 3 }, (_, n) => ({ id: `a${n}`, chat: ALICE, at: at(5 - n), Text: "x" })),
    )
    const all = await pages({ limit: 1 })
    expect(all.map(idsOf)).toEqual([["b1"]])
  })

  test(
    "counts excluded hits toward what wacli is asked for, so a search that meets the cap is `incomplete` and still pages on",
    async () => {
      t.add(
        ...Array.from({ length: SEARCH_FETCH_CAP + 5 }, (_, n) => ({
          id: `a${n}`,
          chat: ALICE,
          at: at(5 + n),
          Text: "x",
        })),
        { id: "b1", chat: BOB, at: at(3), Text: "x" },
      )
      // Newest first, so the window holds the newest excluded hits and leaves out the allowed one.
      t.mirror.relevance = t.mirror.messages
        .map((row) => row.MsgID as string)
        .filter((id) => id.startsWith("a"))
        .reverse()
      t.sync()
      const first = await search({ limit: 3 })
      expect(first.messages).toEqual([])
      expect(first.incomplete).toBe(true)
      expect(first.next).toBeDefined()
      const rest = await pages({ limit: 3, cursor: first.next })
      expect(rest.flatMap((page) => idsOf(page) ?? [])).toEqual(["b1"])
      expect(rest.at(-1)?.incomplete).toBeUndefined()
    },
    SLOW_TEST_MS,
  )

  test("refuses a cursor taken under another setting, and a cursor carries no excluded JID", async () => {
    t.add(
      { id: "b1", chat: BOB, at: at(3), Text: "x" },
      { id: "b2", chat: BOB, at: at(2), Text: "x" },
      { id: "b3", chat: BOB, at: at(1), Text: "x" },
    )
    const first = await search({ limit: 1 })
    const cursor = JSON.stringify(decodeCursor(first.next!, "cursor"))
    expect(cursor).not.toContain(ALICE)
    expect(cursor).not.toContain("15550100001")
    expect(idsOf(await search({ limit: 1, cursor: first.next }))).toEqual(["b2"])

    for (const other of [[], [ALICE, BOB], [HIDDEN]]) {
      t.exclude(...other)
      const error = await t.failure({ method: "search", query: "x", limit: 1, cursor: first.next })
      expect(error.message).toBe("cursor is not a cursor this tool returned.")
    }
  })

  test("is unchanged when the setting names a chat with no hit", async () => {
    t.add({ id: "b1", chat: BOB, at: at(1), Text: "x" }, { id: "a1", chat: ALICE, at: at(2), Text: "x" })
    t.exclude("14155550123@s.whatsapp.net")
    expect(idsOf(await search())).toEqual(["a1", "b1"])
  })
})

describe("chat read: search in one chat that wacli covers with an excluded JID of the same person", () => {
  beforeEach(() => {
    t.mirror.aliases = [[ALICE, HIDDEN]]
  })

  test("leaves out the hits wacli files under the excluded JID, and pages past a run of them", async () => {
    t.add(
      { id: "h1", chat: HIDDEN, at: at(9), Text: "x" },
      ...Array.from({ length: 4 }, (_, n) => ({ id: `a${n}`, chat: ALICE, at: at(8 - n), Text: "x secret" })),
      { id: "h2", chat: HIDDEN, at: at(2), Text: "x" },
    )
    const all = await pages({ chat: HIDDEN, limit: 1 })
    expect(all.map(idsOf)).toEqual([["h1"], ["h2"]])
    expect(JSON.stringify(all)).not.toContain("secret")
    expect(all.every((page) => page.unreadable_rows === undefined)).toBe(true)
  })
})
