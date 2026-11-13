import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { decodeCursor } from "../pages"
import { ALICE, BOB, HIDDEN, TEAM, at, createChatFixture, wacliChat, type ChatFixture } from "./read.testing"

const CAROL = "15550100003@s.whatsapp.net"

let t: ChatFixture

beforeEach(async () => {
  t = await createChatFixture()
  t.addChats(
    wacliChat({ jid: ALICE, name: "Alice", last_message_ts: new Date(at(50)).toISOString() }),
    wacliChat({ jid: BOB, name: "Bob", last_message_ts: new Date(at(40)).toISOString() }),
    wacliChat({ jid: TEAM, kind: "group", name: "Team", last_message_ts: new Date(at(30)).toISOString() }),
    wacliChat({ jid: CAROL, name: "Carol", last_message_ts: new Date(at(20)).toISOString() }),
    wacliChat({ jid: HIDDEN, name: "Hidden", last_message_ts: new Date(at(10)).toISOString() }),
  )
})

afterEach(async () => {
  await t.close()
})

const listed = async (args: Record<string, unknown> = {}) => t.read({ method: "list", ...args })
const idsOf = (result: Awaited<ReturnType<typeof listed>>) => result.chats?.map((chat) => chat.id)

describe("chat read: list with excluded chats", () => {
  test("leaves out an excluded chat, and a page is as full as it would be without them", async () => {
    t.exclude(ALICE, TEAM)
    expect(idsOf(await listed())).toEqual([BOB, CAROL, HIDDEN])
    const first = await listed({ limit: 2 })
    expect(idsOf(first)).toEqual([BOB, CAROL])
    const second = await listed({ limit: 2, cursor: first.next })
    expect(idsOf(second)).toEqual([HIDDEN])
    expect(second.next).toBeUndefined()
  })

  test("leaves them out of a search by query too, and does not look up their last message", async () => {
    t.add({ id: "a1", chat: ALICE, at: at(1), Text: "secret" }, { id: "b1", chat: BOB, at: at(2), Text: "fine" })
    t.exclude(ALICE)
    const result = await listed({ query: "a", last: true })
    expect(idsOf(result)).not.toContain(ALICE)
    expect(JSON.stringify(result)).not.toContain("secret")
    const reads = (await t.fake.calls()).filter((call) => call.argv.includes("messages") && call.argv.includes("list"))
    expect(reads.some((call) => call.argv.includes(ALICE))).toBe(false)
    expect(result.chats?.find((chat) => chat.id === BOB)?.last_message?.text).toBe("fine")
  })

  test("is unchanged without the setting, and with a setting that names no listed chat", async () => {
    const all = [ALICE, BOB, TEAM, CAROL, HIDDEN]
    expect(idsOf(await listed())).toEqual(all)
    t.exclude("14155550123@s.whatsapp.net")
    expect(idsOf(await listed())).toEqual(all)
  })

  test("refuses a cursor taken under another setting, and a cursor carries no excluded JID", async () => {
    t.exclude(ALICE)
    const first = await listed({ limit: 1 })
    const cursor = JSON.stringify(decodeCursor(first.next!, "cursor"))
    expect(cursor).not.toContain(ALICE)
    expect(cursor).not.toContain("15550100001")
    expect(idsOf(await listed({ limit: 1, cursor: first.next }))).toEqual([TEAM])

    for (const other of [[], [ALICE, BOB], [BOB]]) {
      t.exclude(...other)
      const error = await t.failure({ method: "list", limit: 1, cursor: first.next })
      expect(error.message).toBe("cursor is not a cursor this tool returned.")
    }
  })

  test("binds a cursor to the set and not to the order it was given in", async () => {
    t.exclude(ALICE, TEAM)
    const first = await listed({ limit: 1 })
    t.exclude(TEAM, ALICE)
    expect(idsOf(await listed({ limit: 1, cursor: first.next }))).toEqual([CAROL])
  })

  test("leaves out of a chat's last message a row wacli files under an excluded JID of the same person", async () => {
    t.mirror.aliases = [[ALICE, HIDDEN]]
    t.add(
      { id: "h1", chat: HIDDEN, at: at(1), Text: "old, allowed" },
      { id: "a1", chat: ALICE, at: at(2), Text: "newer, excluded" },
    )
    t.exclude(ALICE)
    const result = await listed({ last: true })
    expect(idsOf(result)).toEqual([BOB, TEAM, CAROL, HIDDEN])
    expect(result.chats?.find((chat) => chat.id === HIDDEN)?.last_message).toMatchObject({ id: "h1" })
    expect(JSON.stringify(result)).not.toContain("excluded")
  })
})
