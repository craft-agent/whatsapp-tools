import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, TEAM, wacliChat } from "../read.testing"
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
const THIRD = "15550100004@s.whatsapp.net"

describe("the limit of pinned chats with excluded chats", () => {
  const pinned = (...jids: string[]) => jids.map((jid) => wacliChat({ jid, name: jid, pinned: true }))
  const rest = [wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: TEAM, kind: "group", name: "Team" })]

  test("counts an excluded pinned chat, since WhatsApp's limit of three is about every chat", async () => {
    await t.serve({ mirror: { chats: [...pinned(BOB, OTHER, THIRD), ...rest] } })
    t.exclude(BOB)
    const error = await t.failure(whatsappChatPin, { chat: ALICE, pinned: true })
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("three are pinned")
    expect(await t.changeCalls()).toEqual([])
  })

  test("still pins a third chat when two are pinned, one of them excluded", async () => {
    await t.serve({ mirror: { chats: [...pinned(BOB, OTHER), ...rest] } })
    t.exclude(BOB)
    expect(await t.run(whatsappChatPin, { chat: ALICE, pinned: true })).toMatchObject({ pinned: true })
  })
})
