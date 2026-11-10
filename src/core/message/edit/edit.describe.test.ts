import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, NEWS, TEAM, wacliChat } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { MS_PER_MINUTE } from "../../time"
import { translator } from "../../words"
import { MESSAGE_WORDS } from "../words"
import { CURRENT_TEXT, MESSAGE_ID, ago, createEditTest, ownMessageRow, type EditTest } from "./edit.testing"
import { whatsappMessageEdit } from "./tool"
import { EDIT_TRANSLATIONS, EDIT_WORDS } from "./words"

let t: EditTest

beforeEach(async () => {
  t = await createEditTest()
})

afterEach(async () => {
  await t.close()
})

const SENT_AT = ago(5 * MS_PER_MINUTE)

const MIRROR = {
  chats: [
    wacliChat({ jid: ALICE, name: "Alice" }),
    wacliChat({ jid: BOB }),
    wacliChat({ jid: TEAM, kind: "group", name: "Team" }),
    wacliChat({ jid: NEWS, kind: "channel", name: "News" }),
  ],
  messages: [
    ownMessageRow({ at: SENT_AT }),
    ownMessageRow({ id: "3EB0BBBBBBBBBBBB", chat: BOB, at: SENT_AT }),
    ownMessageRow({ id: "3EB0CCCCCCCCCCCC", chat: TEAM, at: SENT_AT }),
  ],
}

const describeCall = (args: Record<string, unknown>) =>
  callDescription(
    whatsappMessageEdit,
    { id: MESSAGE_ID, ...args },
    { cwd: t.fixture.stateDir, stateDir: t.fixture.stateDir },
  )

/** A time as the prompt writes it, built from the local calendar fields of the instant. */
function minuteOf(ms: number): string {
  const d = new Date(Math.floor(ms / 1000) * 1000)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

describe("the description of a message edit", () => {
  beforeEach(() => t.setUp({ mirror: MIRROR }))

  test("tells the chat, when the message was sent, what it says now, and the trimmed new text", async () => {
    expect(await describeCall({ chat: ALICE, text: "  See you at 7  " })).toEqual({
      headline: { text: EDIT_WORDS.headline, values: { chat: "Alice" } },
      facts: [
        { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.person } },
        { label: EDIT_WORDS.sentLabel, value: minuteOf(SENT_AT) },
        { label: EDIT_WORDS.currentLabel, value: CURRENT_TEXT },
      ],
      text: { label: EDIT_WORDS.textLabel, body: "See you at 7" },
    })
  })

  test("tells a group", async () => {
    const description = await describeCall({ chat: TEAM, id: "3EB0CCCCCCCCCCCC", text: "See you at 7" })
    expect(description?.headline?.values).toEqual({ chat: "Team" })
    expect(description?.facts[0]).toEqual({ label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.group } })
  })

  test("names a person with no mirror name by the number", async () => {
    const description = await describeCall({ chat: BOB, id: "3EB0BBBBBBBBBBBB", text: "See you at 7" })
    expect(description?.headline?.values).toEqual({ chat: "+15550100002" })
  })

  test.each([
    ["a name instead of a JID", { chat: "Alice" }],
    ["a channel", { chat: NEWS }],
    ["a chat the mirror lacks", { chat: "15550100009@s.whatsapp.net" }],
    ["an id that is not a message id", { chat: ALICE, id: "../x" }],
    ["an id the chat does not have", { chat: ALICE, id: "NOSUCHMESSAGE" }],
    ["an empty text", { chat: ALICE, text: "   " }],
    ["a text over the limit", { chat: ALICE, text: "x".repeat(70_000) }],
    ["the current text", { chat: ALICE, text: CURRENT_TEXT }],
  ])("gives no description for %s", async (_what, args) => {
    expect(await describeCall({ text: "See you at 7", ...args })).toBeUndefined()
  })

  test("gives no description for a message that is not the user's, or too old", async () => {
    t.setUp({
      mirror: {
        chats: [wacliChat({ jid: ALICE })],
        messages: [
          ownMessageRow({ id: "THEIRS", FromMe: false }),
          ownMessageRow({ id: "TOOOLD", at: ago(20 * MS_PER_MINUTE) }),
        ],
      },
    })
    expect(await describeCall({ chat: ALICE, id: "THEIRS", text: "See you at 7" })).toBeUndefined()
    expect(await describeCall({ chat: ALICE, id: "TOOOLD", text: "See you at 7" })).toBeUndefined()
  })

  test("only reads: every wacli call carries --read-only, and nothing is edited", async () => {
    await describeCall({ chat: ALICE, text: "See you at 7" })
    const calls = await t.wacliCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.argv).toContain("--read-only")
    expect(await t.editCalls()).toEqual([])
  })

  test("gives the same answer for the same state, so that the approval pins it", async () => {
    const args = { chat: ALICE, text: "See you at 7" }
    expect(await describeCall(args)).toEqual(await describeCall(args))
  })

  test("has a Japanese headline", async () => {
    const description = await describeCall({ chat: ALICE, text: "See you at 7" })
    expect(translator(EDIT_TRANSLATIONS, "ja").template(description!.headline!.text)).toBe(
      "{chat} の自分のメッセージを編集しようとしています",
    )
  })
})
