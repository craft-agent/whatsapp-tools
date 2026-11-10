import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, HIDDEN, NEWS, TEAM, wacliChat } from "../read.testing"
import { whatsappChatArchive } from "./archive"
import { whatsappChatMute } from "./mute"
import { whatsappChatPin } from "./pin"
import { createStateTest, type StateTest } from "./state.testing"

let t: StateTest

beforeEach(async () => {
  t = await createStateTest()
})

afterEach(async () => {
  await t.close()
})

const OTHER = "15550100003@s.whatsapp.net"

const CALLS = [
  ["whatsapp_chat_archive", whatsappChatArchive, { archived: true }],
  ["whatsapp_chat_pin", whatsappChatPin, { pinned: true }],
  ["whatsapp_chat_mute", whatsappChatMute, { mute: "always" }],
] as const

describe.each(CALLS)("the chat of %s", (_id, tool, change) => {
  test("is not_found when the mirror does not hold it, pointing to the chat list", async () => {
    await t.serve()
    const error = await t.failure(tool, { chat: OTHER, ...change })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("whatsapp_chat_read list")
    expect(await t.changeCalls()).toEqual([])
  })

  test("is not_found for a contact whose number is hidden when the mirror does not hold it", async () => {
    await t.serve()
    expect((await t.failure(tool, { chat: HIDDEN, ...change })).code).toBe("not_found")
    expect(await t.changeCalls()).toEqual([])
  })

  test.each([
    ["a channel the mirror holds", wacliChat({ jid: NEWS, kind: "channel", name: "News" }), NEWS],
    ["a chat the mirror says is a broadcast list", wacliChat({ jid: ALICE, kind: "broadcast" }), ALICE],
  ])("is invalid_argument for %s", async (_what, row, chat) => {
    await t.serve({ mirror: { chats: [row] } })
    const error = await t.failure(tool, { chat, ...change })
    expect(error.code).toBe("invalid_argument")
    expect(await t.changeCalls()).toEqual([])
  })

  test.each([
    ["a person", ALICE],
    ["a person with no name", BOB],
    ["a group", TEAM],
  ])("may be %s", async (_what, chat) => {
    await t.serve()
    expect(await t.run(tool, { chat, ...change })).toMatchObject({ chat })
    expect(await t.changeCalls()).toHaveLength(1)
  })

  test("may be a contact whose number is hidden, or the user's own chat, once the mirror holds it", async () => {
    const own = "15550100000@s.whatsapp.net"
    await t.serve({ mirror: { chats: [wacliChat({ jid: HIDDEN, name: "Hidden" }), wacliChat({ jid: own })] } })
    expect(await t.run(tool, { chat: HIDDEN, ...change })).toMatchObject({ chat: HIDDEN })
    expect(await t.run(tool, { chat: own, ...change })).toMatchObject({ chat: own })
  })

  test("is sent even when the mirror already shows the state, which may lag", async () => {
    const state = { archived: true, pinned: true, muted_until: -1 }
    await t.serve({ mirror: { chats: [wacliChat({ jid: ALICE, name: "Alice", ...state })] } })
    await t.run(tool, { chat: ALICE, ...change })
    expect(await t.changeCalls()).toHaveLength(1)
  })
})

describe("the limit of pinned chats", () => {
  const pinned = (...jids: string[]) => jids.map((jid) => wacliChat({ jid, name: jid, pinned: true }))
  const THIRD = "15550100004@s.whatsapp.net"
  const THREE = pinned(BOB, OTHER, THIRD)
  const rest = [wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: TEAM, kind: "group", name: "Team" })]

  test("refuses a pin as forbidden when three chats are pinned, saying to unpin one, and changes nothing", async () => {
    await t.serve({ mirror: { chats: [...THREE, ...rest] } })
    const error = await t.failure(whatsappChatPin, { chat: ALICE, pinned: true })
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe(
      "WhatsApp pins at most three chats, and three are pinned. Unpin one first. Nothing was changed.",
    )
    expect(await t.changeCalls()).toEqual([])
  })

  test("refuses a group the same way", async () => {
    await t.serve({ mirror: { chats: [...THREE, ...rest] } })
    expect((await t.failure(whatsappChatPin, { chat: TEAM, pinned: true })).code).toBe("forbidden")
  })

  test("pins a third chat when two are pinned", async () => {
    await t.serve({ mirror: { chats: [...pinned(BOB, OTHER), ...rest] } })
    expect(await t.run(whatsappChatPin, { chat: ALICE, pinned: true })).toMatchObject({ pinned: true })
    expect(await t.changeCalls()).toHaveLength(1)
  })

  test("lets a chat that is pinned be pinned again with three pinned, since it sets a state", async () => {
    await t.serve({ mirror: { chats: [...THREE, ...rest] } })
    expect(await t.run(whatsappChatPin, { chat: BOB, pinned: true })).toMatchObject({ chat: BOB, pinned: true })
    expect(await t.changeCalls()).toHaveLength(1)
  })

  test("lets a chat be unpinned with three pinned, whether it is one of them or not", async () => {
    await t.serve({ mirror: { chats: [...THREE, ...rest] } })
    expect(await t.run(whatsappChatPin, { chat: BOB, pinned: false })).toMatchObject({ pinned: false })
    expect(await t.run(whatsappChatPin, { chat: ALICE, pinned: false })).toMatchObject({ pinned: false })
    expect(await t.changeCalls()).toHaveLength(2)
  })

  test("asks the mirror for the pinned chats only, so that no limit on a list hides one", async () => {
    await t.serve({ mirror: { chats: [...THREE, ...rest] } })
    await t.failure(whatsappChatPin, { chat: ALICE, pinned: true })
    const lists = (await t.wacliCalls()).filter((call) => call.argv.includes("list"))
    expect(lists).toHaveLength(1)
    expect(lists[0]!.argv).toContain("--pinned")
    expect(lists[0]!.argv).toContain("--read-only")
  })

  test("does not count pinned chats for archiving or muting", async () => {
    await t.serve({ mirror: { chats: [...THREE, ...rest] } })
    expect(await t.run(whatsappChatArchive, { chat: ALICE, archived: true })).toMatchObject({ archived: true })
    expect(await t.run(whatsappChatMute, { chat: ALICE, mute: "off" })).toMatchObject({ mute: "off" })
    expect((await t.wacliCalls()).filter((call) => call.argv.includes("list"))).toEqual([])
  })
})
