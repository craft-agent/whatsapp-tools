import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, HIDDEN, NEWS, TEAM, at, wacliChat, wacliMessage } from "../chat/read.testing"
import { callDescription } from "../describe"
import { translator } from "../words"
import { whatsappMessageSend } from "./send"
import { REPLY_ID, createSendTest, type SendTest } from "./send.testing"
import { MESSAGE_TRANSLATIONS, MESSAGE_WORDS } from "./words"

let t: SendTest

const NEW_PERSON = "15550100009@s.whatsapp.net"
const REPLY_FROM_ME = "3EB0AAAAAAAAAAAA"

beforeEach(async () => {
  t = await createSendTest()
})

afterEach(async () => {
  await t.close()
})

const describeCall = (args: Record<string, unknown>) =>
  callDescription(whatsappMessageSend, args, { cwd: t.fixture.stateDir, stateDir: t.fixture.stateDir })

/** A time as the prompt writes it, built from the local calendar fields of the instant. */
function minuteOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

const MIRROR = {
  chats: [
    wacliChat({ jid: ALICE, name: "Alice" }),
    wacliChat({ jid: BOB, name: "  " }),
    wacliChat({ jid: TEAM, kind: "group", name: "Team" }),
    wacliChat({ jid: NEWS, kind: "channel", name: "News" }),
  ],
  messages: [
    wacliMessage({ id: REPLY_ID, chat: ALICE, at: at(1), SenderName: "Alice A" }),
    wacliMessage({ id: REPLY_FROM_ME, chat: ALICE, at: at(2), FromMe: true }),
  ],
}

describe("the description of a message send", () => {
  beforeEach(() => t.setUp({ mirror: MIRROR }))

  test("tells a named person, with the trimmed text", async () => {
    expect(await describeCall({ chat: ALICE, text: "  hello  " })).toEqual({
      headline: { text: MESSAGE_WORDS.headline, values: { chat: "Alice" } },
      facts: [{ label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.person } }],
      text: { label: MESSAGE_WORDS.textLabel, body: "hello" },
    })
  })

  test("tells a group", async () => {
    const description = await describeCall({ chat: TEAM, text: "hi" })
    expect(description?.headline?.values).toEqual({ chat: "Team" })
    expect(description?.facts).toEqual([{ label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.group } }])
  })

  test("names a person with no mirror name by the number", async () => {
    expect((await describeCall({ chat: BOB, text: "hi" }))?.headline?.values).toEqual({ chat: "+15550100002" })
  })

  test("tells a new person by the number, without asking WhatsApp", async () => {
    const description = await describeCall({ chat: NEW_PERSON, text: "hi" })
    expect(description?.headline?.values).toEqual({ chat: "+15550100009" })
    expect(description?.facts).toEqual([{ label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.newPerson } }])
    const calls = await t.wacliCalls()
    expect(calls.filter((call) => call.argv.includes("check") || call.argv.includes("send"))).toEqual([])
  })

  test.each([
    ["a hidden-number contact the mirror lacks", { chat: HIDDEN, text: "hi" }],
    ["a channel", { chat: NEWS, text: "hi" }],
    ["a name instead of a JID", { chat: "Alice", text: "hi" }],
    ["an empty text", { chat: ALICE, text: "   " }],
    ["a text over the limit", { chat: ALICE, text: "x".repeat(70_000) }],
    ["a reply from a new person", { chat: NEW_PERSON, text: "hi", reply_to: REPLY_ID }],
    ["a reply to a message not in the chat", { chat: ALICE, text: "hi", reply_to: "NOSUCHMESSAGE" }],
  ])("gives no description for %s", async (_what, args) => {
    expect(await describeCall(args)).toBeUndefined()
  })

  test("tells whom a reply quotes and when, never the text", async () => {
    const description = await describeCall({ chat: ALICE, text: "hi", reply_to: REPLY_ID })
    expect(description?.facts[1]).toEqual({
      label: MESSAGE_WORDS.replyLabel,
      value: { text: MESSAGE_WORDS.replyFrom, values: { sender: "Alice A", time: minuteOf(at(1)) } },
    })
  })

  test("tells a reply to one's own message as You", async () => {
    const description = await describeCall({ chat: ALICE, text: "hi", reply_to: REPLY_FROM_ME })
    expect(description?.facts[1]?.value).toEqual({
      text: MESSAGE_WORDS.replyFromMe,
      values: { time: minuteOf(at(2)) },
    })
  })

  test("only reads: every wacli call carries --read-only", async () => {
    await describeCall({ chat: ALICE, text: "hi", reply_to: REPLY_ID })
    await describeCall({ chat: NEW_PERSON, text: "hi" })
    const calls = await t.wacliCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.argv).toContain("--read-only")
  })

  test("has a Japanese headline", async () => {
    const description = await describeCall({ chat: ALICE, text: "hi" })
    expect(translator(MESSAGE_TRANSLATIONS, "ja").template(description!.headline!.text)).toBe(
      "{chat} にメッセージを送ろうとしています",
    )
  })
})
