import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { formatLocalTime } from "../time"
import { ALICE, TEAM, at, createChatFixture, wacliChat, type ChatFixture } from "./read.testing"
import { SCAN_LIMIT } from "./scan"

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: TEAM, kind: "group", name: "Team" }))
})

afterEach(async () => {
  await t.close()
})

/** Ten messages in the chat of Alice, one a second: "m0" (oldest) to "m9". */
function fillChat() {
  t.add(...Array.from({ length: 10 }, (_, n) => ({ id: `m${n}`, at: at(n), Text: `m${n}` })))
}

const unreadable = (id: string, second: number) => ({ id, at: at(second) })

async function view(args: Record<string, unknown> = {}) {
  return t.read({ method: "view", chat: ALICE, ...args })
}

describe("chat read: paging a view", () => {
  test("continues with older messages through next, without a gap or a repeat", async () => {
    fillChat()
    const pages = await t.pages(ALICE, { limit: 4 })
    expect(pages.map((page) => page.messages?.map((message) => message.id))).toEqual([
      ["m6", "m7", "m8", "m9"],
      ["m2", "m3", "m4", "m5"],
      ["m0", "m1"],
    ])
  })

  test("continuing keeps the range", async () => {
    fillChat()
    const range = { after: formatLocalTime(at(1)), before: formatLocalTime(at(8)) }
    const first = await view({ limit: 3, ...range })
    expect(first.messages?.map((message) => message.id)).toEqual(["m5", "m6", "m7"])
    const second = await view({ limit: 10, cursor: first.next, ...range })
    expect(second.messages?.map((message) => message.id)).toEqual(["m2", "m3", "m4"])
    expect(second.next).toBeUndefined()
  })

  test("messages of one second are told apart by the ids the cursor holds", async () => {
    t.add(
      { id: "a", at: at(0), Text: "a" },
      { id: "b", at: at(5), Text: "b" },
      { id: "c", at: at(5) + 100, Text: "c" },
      { id: "d", at: at(5) + 200, Text: "d" },
      { id: "e", at: at(9), Text: "e" },
    )
    const pages = await t.pages(ALICE, { limit: 2 })
    expect(pages.map((page) => page.messages?.map((message) => message.id))).toEqual([["d", "e"], ["b", "c"], ["a"]])
  })

  test("messages that arrive between two pages move no page", async () => {
    fillChat()
    const first = await view({ limit: 4 })
    expect(first.messages?.map((message) => message.id)).toEqual(["m6", "m7", "m8", "m9"])
    t.add(
      { id: "new1", at: at(10), Text: "new1" },
      { id: "new2", at: at(11), Text: "new2" },
      { id: "late6", at: at(6), Text: "late6" },
      { id: "late1", at: at(1), Text: "late1" },
    )
    const second = await view({ limit: 4, cursor: first.next })
    expect(second.messages?.map((message) => message.id)).toEqual(["m3", "m4", "m5", "late6"])
    const third = await view({ limit: 4, cursor: second.next })
    expect(third.messages?.map((message) => message.id)).toEqual(["m0", "m1", "late1", "m2"])
    expect(third.next).toBeUndefined()
  })

  test("a message deleted between two pages leaves the rest where it was", async () => {
    fillChat()
    const first = await view({ limit: 3 })
    t.mirror.messages.splice(
      t.mirror.messages.findIndex((row) => row.MsgID === "m9"),
      1,
    )
    t.sync()
    const second = await view({ limit: 3, cursor: first.next })
    expect(second.messages?.map((message) => message.id)).toEqual(["m4", "m5", "m6"])
  })

  test("a cursor belongs to the chat and the bounds it came from", async () => {
    fillChat()
    t.add({ id: "g1", chat: TEAM, at: at(20), Text: "g1" }, { id: "g2", chat: TEAM, at: at(21), Text: "g2" })
    const first = await view({ limit: 2 })
    const group = await t.read({ method: "view", chat: TEAM, limit: 1 })
    for (const args of [
      { chat: TEAM, cursor: first.next },
      { chat: ALICE, cursor: group.next },
      { chat: ALICE, cursor: first.next, after: formatLocalTime(at(1)) },
      { chat: ALICE, cursor: first.next, before: formatLocalTime(at(9)) },
    ]) {
      const error = await t.failure({ method: "view", ...args })
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toBe("cursor is not a cursor this tool returned.")
    }
    expect((await t.read({ method: "view", chat: TEAM, cursor: group.next })).messages?.map((m) => m.id)).toEqual([
      "g1",
    ])
  })

  test("refuses a cursor of the list method, a garbled cursor and a limit below 1", async () => {
    fillChat()
    t.addChats(wacliChat({ jid: "15550100003@s.whatsapp.net", name: "Cy", last_message_ts: "2026-11-07T05:00:00Z" }))
    const list = await t.read({ method: "list", limit: 1 })
    expect(list.next).toBeDefined()
    for (const cursor of [list.next!, "garbage"]) {
      expect((await t.failure({ method: "view", chat: ALICE, cursor })).message).toBe(
        "cursor is not a cursor this tool returned.",
      )
    }
    expect((await t.failure({ method: "view", chat: ALICE, limit: 0 })).code).toBe("invalid_argument")
  })
})

describe("chat read: unreadable rows", () => {
  /** One readable message at the top, 30 unreadable rows, then readable messages "r0".. below them. */
  function protocolTraffic() {
    t.add(
      ...Array.from({ length: 5 }, (_, n) => ({ id: `r${n}`, at: at(n), Text: `r${n}` })),
      ...Array.from({ length: 30 }, (_, n) => unreadable(`u${n}`, 5 + n)),
      { id: "top", at: at(40), Text: "top" },
    )
  }

  test("are dropped and counted, and the scan reads past them in more than one chunk", async () => {
    protocolTraffic()
    const result = await view({ limit: 2 })
    expect(result.messages?.map((message) => message.id)).toEqual(["r4", "top"])
    expect(result.unreadable_rows).toBe(30)
    expect(result.next).toBeDefined()
    const reads = (await t.fake.calls()).filter((call) => call.argv.includes("messages"))
    expect(reads.length).toBeGreaterThan(1)
    expect(reads.length).toBeLessThan(10)
  })

  test("are counted once across pages, in the page that passed them", async () => {
    protocolTraffic()
    const pages = await t.pages(ALICE, { limit: 2 })
    expect(t.ids(pages)).toEqual(["r4", "top", "r2", "r3", "r0", "r1"])
    expect(pages.map((page) => page.unreadable_rows)).toEqual([30, undefined, undefined])
    expect(pages[2]?.next).toBeUndefined()
  })

  test("after the last message they are counted and end the read", async () => {
    t.add({ id: "only", at: at(5), Text: "only" }, unreadable("u0", 1), unreadable("u1", 2))
    const result = await view()
    expect(result.messages?.map((message) => message.id)).toEqual(["only"])
    expect(result.unreadable_rows).toBe(2)
    expect(result.next).toBeUndefined()
  })

  test("a chat of nothing else reads as no messages", async () => {
    t.add(unreadable("u0", 1), unreadable("u1", 2))
    const result = await view()
    expect(result.messages).toEqual([])
    expect(result.unreadable_rows).toBe(2)
  })

  test("a reply or a reaction with no text of its own is not one", async () => {
    t.add(
      { id: "reply", at: at(1), DisplayText: "> hello\n(message)", quoted_msg_id: "x" },
      { id: "reaction", at: at(2), DisplayText: "(message)", ReactionToID: "x" },
      { id: "picture", at: at(3), DisplayText: "(message)", MediaType: "image" },
    )
    const result = await view()
    expect(result.messages?.map((message) => message.id)).toEqual(["reply", "reaction", "picture"])
    expect(result.unreadable_rows).toBeUndefined()
  })

  test("a page stops after the most rows one call looks through, and the next page goes on from there", async () => {
    const rows = SCAN_LIMIT + 100
    t.add(
      { id: "oldest", at: at(0), Text: "oldest" },
      ...Array.from({ length: rows }, (_, n) => unreadable(`u${n}`, 1 + n)),
      { id: "newest", at: at(rows + 1), Text: "newest" },
    )
    const first = await view({ limit: 5 })
    expect(first.messages?.map((message) => message.id)).toEqual(["newest"])
    expect(first.unreadable_rows).toBe(SCAN_LIMIT - 1)
    expect(first.next).toBeDefined()
    const second = await view({ limit: 5, cursor: first.next })
    expect(second.messages?.map((message) => message.id)).toEqual(["oldest"])
    expect(second.unreadable_rows).toBe(rows - (SCAN_LIMIT - 1))
    expect(second.next).toBeUndefined()
  }, 60_000)
})
