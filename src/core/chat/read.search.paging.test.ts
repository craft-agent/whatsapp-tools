import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { decodeCursor } from "../pages"
import { formatLocalTime } from "../time"
import { labelPaths } from "../whatsapp/labels"
import { ALICE, TEAM, at, createChatFixture, wacliChat, type ChatFixture } from "./read.testing"
import { SEARCH_FETCH_CAP } from "./search"

/** The time a test that fills the mirror past the cap may take: every wacli call reads a mirror of that size. */
const SLOW_TEST_MS = 30_000

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: TEAM, kind: "group", name: "Team" }))
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

/** Ten messages "x0" (oldest) to "x9", one a second, in the chat of Alice. */
function fillChat() {
  t.add(...Array.from({ length: 10 }, (_, n) => ({ id: `x${n}`, at: at(n), Text: `x${n}` })))
}

describe("chat read: paging a search", () => {
  test("continues with older hits through next, without a gap or a repeat", async () => {
    fillChat()
    expect((await pages({ limit: 4 })).map(idsOf)).toEqual([
      ["x9", "x8", "x7", "x6"],
      ["x5", "x4", "x3", "x2"],
      ["x1", "x0"],
    ])
  })

  test("hits of one second are told apart by the ids the cursor holds", async () => {
    t.add(
      { id: "a", at: at(0), Text: "x" },
      { id: "b", at: at(5), Text: "x" },
      { id: "c", at: at(5) + 100, Text: "x" },
      { id: "d", at: at(5) + 200, Text: "x" },
      { id: "e", at: at(9), Text: "x" },
    )
    const all = await pages({ limit: 2 })
    expect(all.map((page) => page.messages?.length)).toEqual([2, 2, 1])
    expect(all.map(idsOf)).toEqual([["e", "b"], ["c", "d"], ["a"]])
    const cursor = decodeCursor(all[1]!.next!, "cursor") as { second: number; ids: string[] }
    expect(cursor.ids).toHaveLength(3)
    expect(JSON.stringify(cursor)).not.toMatch(/"[bcd]"/)
  })

  test("hits that arrive between two pages move no page", async () => {
    fillChat()
    const first = await search({ limit: 4 })
    t.add(
      { id: "new1", at: at(10), Text: "x" },
      { id: "late6", at: at(6), Text: "x" },
      { id: "late1", at: at(1), Text: "x" },
    )
    const second = await search({ limit: 4, cursor: first.next })
    expect(idsOf(second)).toEqual(["late6", "x5", "x4", "x3"])
    const third = await search({ limit: 4, cursor: second.next })
    expect(idsOf(third)).toEqual(["x2", "late1", "x1", "x0"])
    expect(third.next).toBeUndefined()
  })

  test("continuing keeps the range", async () => {
    fillChat()
    const range = { after: formatLocalTime(at(1)), before: formatLocalTime(at(8)) }
    const first = await search({ limit: 3, ...range })
    expect(idsOf(first)).toEqual(["x7", "x6", "x5"])
    const second = await search({ limit: 10, cursor: first.next, ...range })
    expect(idsOf(second)).toEqual(["x4", "x3", "x2"])
    expect(second.next).toBeUndefined()
  })

  test("a cursor belongs to its query, chat, range and account", async () => {
    fillChat()
    mkdirSync(labelPaths(t.stateDir, "second").dir)
    const base = { query: "x", limit: 2, chat: ALICE, account: "main", after: formatLocalTime(at(0)) }
    const first = await search(base)
    for (const other of [
      { query: "x1" },
      { chat: TEAM },
      { chat: undefined },
      { after: undefined },
      { account: "second" },
    ]) {
      const error = await t.failure({ method: "search", ...base, ...other, cursor: first.next })
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toBe("cursor is not a cursor this tool returned.")
    }
    expect(idsOf(await search({ ...base, cursor: first.next }))).toEqual(["x7", "x6"])
    const view = await t.read({ method: "view", chat: ALICE, limit: 2, account: "main" })
    expect((await t.failure({ method: "search", ...base, cursor: view.next })).code).toBe("invalid_argument")
    expect((await t.failure({ method: "search", ...base, cursor: "not-a-cursor" })).code).toBe("invalid_argument")
  })
})

describe("chat read: a search wacli ranks by relevance", () => {
  test("sorts the hits by time, and is not incomplete while wacli returned them all", async () => {
    t.add(...Array.from({ length: 5 }, (_, n) => ({ id: `x${n}`, at: at(n), Text: `x${n}` })))
    t.mirror.relevance = ["x2", "x4", "x0", "x3", "x1"]
    t.sync()
    const result = await search()
    expect(idsOf(result)).toEqual(["x4", "x3", "x2", "x1", "x0"])
    expect(result.incomplete).toBeUndefined()
    expect(result.next).toBeUndefined()
  })

  /** A little more than the cap of hits, "x0" (oldest) to the newest, one a second. */
  function overfill() {
    t.add(...Array.from({ length: SEARCH_FETCH_CAP + 5 }, (_, n) => ({ id: `x${n}`, at: at(n), Text: "x" })))
  }

  test(
    "says `incomplete` on a page whose window held more than the cap, and not on one that is within it",
    async () => {
      overfill()
      t.mirror.relevance = t.mirror.messages.map((row) => row.MsgID as string)
      t.sync()
      const first = await search({ limit: 3 })
      expect(idsOf(first)).toEqual([`x${SEARCH_FETCH_CAP - 1}`, `x${SEARCH_FETCH_CAP - 2}`, `x${SEARCH_FETCH_CAP - 3}`])
      expect(first.incomplete).toBe(true)
      expect(first.next).toBeDefined()
      const second = await search({ limit: 3, cursor: first.next })
      expect(idsOf(second)).toEqual([
        `x${SEARCH_FETCH_CAP - 4}`,
        `x${SEARCH_FETCH_CAP - 5}`,
        `x${SEARCH_FETCH_CAP - 6}`,
      ])
      expect(second.incomplete).toBeUndefined()
    },
    SLOW_TEST_MS,
  )

  test(
    "a plain match returns exactly the newest hits at the cap, so it continues with next and no warning",
    async () => {
      overfill()
      const first = await search({ limit: 200 })
      expect(idsOf(first)?.[0]).toBe(`x${SEARCH_FETCH_CAP + 4}`)
      expect(first.incomplete).toBeUndefined()
      expect(first.next).toBeDefined()
      const second = await search({ limit: 200, cursor: first.next })
      expect(second.incomplete).toBeUndefined()
      expect(second.messages).toHaveLength(200)
      expect(idsOf(second)?.[0]).toBe(`x${SEARCH_FETCH_CAP + 4 - 200}`)
    },
    SLOW_TEST_MS,
  )
})
