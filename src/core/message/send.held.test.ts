import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { HIDDEN, TEAM, wacliChat } from "../chat/read.testing"
import type { FakeMirror } from "../whatsapp/wacli.testing"
import { CHAT, REPLY_ID, SENT_ID, createSendTest, type SendTest } from "./send.testing"

let t: SendTest

/** The calls the fake got for the number check. */
const checkCalls = async () => (await t.wacliCalls()).filter((call) => call.argv.includes("check"))

beforeEach(async () => {
  t = await createSendTest()
})

afterEach(async () => {
  await t.close()
})

describe("a chat the mirror holds", () => {
  test("is written to when it is a person, a hidden-number contact or a group", async () => {
    const mirror: FakeMirror = {
      chats: [
        wacliChat({ jid: CHAT }),
        wacliChat({ jid: HIDDEN, kind: "unknown" }),
        wacliChat({ jid: TEAM, kind: "group" }),
      ],
    }
    await t.serve({ mirror })
    for (const chat of [CHAT, HIDDEN, TEAM]) {
      expect(await t.run({ chat, text: "hi" })).toMatchObject({ chat, id: SENT_ID })
    }
    expect(await t.sendCalls()).toHaveLength(3)
    expect(await checkCalls()).toEqual([])
  })

  test("is refused as invalid_argument when it is not a person or a group", async () => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT, kind: "broadcast" })] } })
    const error = await t.failure({ chat: CHAT, text: "hi" })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("people and groups only")
    expect(await t.sendCalls()).toEqual([])
  })

  test("is replied to only with a message the mirror holds of it", async () => {
    await t.serve()
    const error = await t.failure({ chat: CHAT, text: "hi", reply_to: "3EB0000000000000" })
    expect(error.code).toBe("not_found")
    expect(await t.sendCalls()).toEqual([])

    await t.run({ chat: CHAT, text: "hi", reply_to: REPLY_ID })
    expect(await t.sendCalls()).toHaveLength(1)
  })
})
