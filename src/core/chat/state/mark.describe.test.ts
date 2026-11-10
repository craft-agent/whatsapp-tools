import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../../describe"
import { MESSAGE_WORDS } from "../../message/words"
import { translator } from "../../words"
import { ALICE, BOB, NEWS, TEAM, wacliChat } from "../read.testing"
import { whatsappChatMark } from "./mark"
import { createStateTest, HELD_MIRROR, type StateTest } from "./state.testing"
import { CHAT_STATE_TRANSLATIONS, MARK_WORDS } from "./words"

let t: StateTest

beforeEach(async () => {
  t = await createStateTest()
  t.setUp({ mirror: { chats: [...HELD_MIRROR.chats!, wacliChat({ jid: NEWS, kind: "channel", name: "News" })] } })
})

afterEach(async () => {
  await t.close()
})

const describeCall = (args: Record<string, unknown>) =>
  callDescription(whatsappChatMark, args, { cwd: t.fixture.stateDir, stateDir: t.fixture.stateDir })

const PERSON = { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.person } }
const GROUP = { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.group } }

describe("the description of marking a chat", () => {
  test("read, with no receipts, tells the chat and that nobody learns of it", async () => {
    expect(await describeCall({ chat: ALICE, read: true })).toEqual({
      headline: { text: MARK_WORDS.readHeadline, values: { chat: "Alice" } },
      facts: [PERSON, { label: MARK_WORDS.receiptsLabel, value: { text: MARK_WORDS.receiptsNone } }],
    })
    expect(await describeCall({ chat: ALICE, read: true, receipts: false })).toEqual(
      await describeCall({ chat: ALICE, read: true }),
    )
  })

  test("read, with receipts, tells the chat and that the senders are told", async () => {
    expect(await describeCall({ chat: TEAM, read: true, receipts: true })).toEqual({
      headline: { text: MARK_WORDS.readHeadline, values: { chat: "Team" } },
      facts: [GROUP, { label: MARK_WORDS.receiptsLabel, value: { text: MARK_WORDS.receiptsSent } }],
    })
  })

  test("unread tells the chat only", async () => {
    expect(await describeCall({ chat: ALICE, read: false })).toEqual({
      headline: { text: MARK_WORDS.unreadHeadline, values: { chat: "Alice" } },
      facts: [PERSON],
    })
  })

  test("names a person with no mirror name by the number", async () => {
    const description = await describeCall({ chat: BOB, read: false })
    expect(description?.headline?.values).toEqual({ chat: "+15550100002" })
  })

  test.each([
    ["a name instead of a JID", { chat: "Alice", read: true }],
    ["a channel", { chat: NEWS, read: true }],
    ["a chat the mirror lacks", { chat: "15550100009@s.whatsapp.net", read: true }],
    ["receipts without read", { chat: ALICE, read: false, receipts: true }],
  ])("gives no description for %s", async (_what, args) => {
    expect(await describeCall(args)).toBeUndefined()
  })

  test("has no text section, and only reads: every wacli call carries --read-only, and nothing is changed", async () => {
    const description = await describeCall({ chat: ALICE, read: true, receipts: true })
    expect(description).not.toHaveProperty("text")
    const calls = await t.wacliCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.argv).toContain("--read-only")
    expect(await t.changeCalls()).toEqual([])
  })

  test("gives the same answer for the same state, so that the approval pins it", async () => {
    const args = { chat: ALICE, read: true, receipts: true }
    expect(await describeCall(args)).toEqual(await describeCall(args))
  })

  test("has Japanese words for the headlines, the title, the intent and the receipts", () => {
    const ja = translator(CHAT_STATE_TRANSLATIONS, "ja")
    expect(ja.template(MARK_WORDS.readHeadline)).toBe("{chat} を既読にしようとしています")
    expect(ja.template(MARK_WORDS.unreadHeadline)).toBe("{chat} を未読にしようとしています")
    expect(ja.word(MARK_WORDS.title)).toBe("チャットを既読・未読にする")
    expect(ja.word(MARK_WORDS.intent)).toBe("チャットの既読・未読を切り替えようとしています")
    expect(ja.word(MARK_WORDS.receiptsLabel)).toBe("受信確認")
    expect(ja.word(MARK_WORDS.receiptsSent)).toBe("未読メッセージ最大 100 件の送信者に送る")
    expect(ja.word(MARK_WORDS.receiptsNone)).toBe("送らない（誰にも伝わらない）")
  })
})
