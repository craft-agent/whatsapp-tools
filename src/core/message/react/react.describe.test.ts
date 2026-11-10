import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, NEWS, TEAM, wacliChat } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { MS_PER_MINUTE } from "../../time"
import { translator } from "../../words"
import { MESSAGE_WORDS } from "../words"
import { MESSAGE_ID, THUMBS_UP, ago, createReactTest, messageRow, type ReactTest } from "./react.testing"
import { whatsappMessageReact } from "./tool"
import { REACT_TRANSLATIONS, REACT_WORDS } from "./words"

let t: ReactTest

beforeEach(async () => {
  t = await createReactTest()
})

afterEach(async () => {
  await t.close()
})

const SENT_AT = ago(5 * MS_PER_MINUTE)
const OWN_ID = "3EB0BBBBBBBBBBBB"
const GROUP_ID = "3EB0CCCCCCCCCCCC"
const NO_NAME_ID = "3EB0DDDDDDDDDDDD"

const MIRROR = {
  chats: [
    wacliChat({ jid: ALICE, name: "Alice" }),
    wacliChat({ jid: BOB }),
    wacliChat({ jid: TEAM, kind: "group", name: "Team" }),
    wacliChat({ jid: NEWS, kind: "channel", name: "News" }),
  ],
  messages: [
    messageRow({ at: SENT_AT, SenderName: "Alice A." }),
    messageRow({ id: OWN_ID, at: SENT_AT, FromMe: true }),
    messageRow({ id: GROUP_ID, chat: TEAM, at: SENT_AT, SenderName: "Bob B." }),
    messageRow({ id: NO_NAME_ID, chat: BOB, at: SENT_AT }),
  ],
}

const describeCall = (args: Record<string, unknown>) =>
  callDescription(
    whatsappMessageReact,
    { chat: ALICE, id: MESSAGE_ID, emoji: THUMBS_UP, ...args },
    { cwd: t.fixture.stateDir, stateDir: t.fixture.stateDir },
  )

/** A time as the prompt writes it, built from the local calendar fields of the instant. */
function minuteOf(ms: number): string {
  const d = new Date(Math.floor(ms / 1000) * 1000)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

describe("the description of a reaction", () => {
  beforeEach(() => t.setUp({ mirror: MIRROR }))

  test("tells the emoji, the chat, who wrote the message and when it was sent, and never its text", async () => {
    const description = await describeCall({})
    expect(description).toEqual({
      headline: { text: REACT_WORDS.headline, values: { emoji: THUMBS_UP, chat: "Alice" } },
      facts: [
        { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.person } },
        { label: REACT_WORDS.fromLabel, value: "Alice A." },
        { label: MESSAGE_WORDS.sentLabel, value: minuteOf(SENT_AT) },
      ],
    })
    expect(JSON.stringify(description)).not.toContain("See you at 6")
  })

  test("tells a removal without an emoji", async () => {
    const description = await describeCall({ emoji: undefined, remove: true })
    expect(description?.headline).toEqual({ text: REACT_WORDS.removeHeadline, values: { chat: "Alice" } })
    expect(description?.facts).toHaveLength(3)
    expect(description).not.toHaveProperty("text")
  })

  test("tells the user's own message as You", async () => {
    const description = await describeCall({ id: OWN_ID })
    expect(description?.facts[1]).toEqual({ label: REACT_WORDS.fromLabel, value: { text: REACT_WORDS.fromMe } })
  })

  test("tells a group, and the author by the name the mirror has", async () => {
    const description = await describeCall({ chat: TEAM, id: GROUP_ID })
    expect(description?.headline?.values).toEqual({ emoji: THUMBS_UP, chat: "Team" })
    expect(description?.facts[0]).toEqual({ label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.group } })
    expect(description?.facts[1]).toEqual({ label: REACT_WORDS.fromLabel, value: "Bob B." })
  })

  test("names a person with no mirror name by the number, as the chat and as the author", async () => {
    const description = await describeCall({ chat: BOB, id: NO_NAME_ID })
    expect(description?.headline?.values).toEqual({ emoji: THUMBS_UP, chat: "+15550100002" })
    expect(description?.facts[1]).toEqual({ label: REACT_WORDS.fromLabel, value: "+15550100002" })
  })

  test.each([
    ["a name instead of a JID", { chat: "Alice" }],
    ["a channel", { chat: NEWS }],
    ["a chat the mirror lacks", { chat: "15550100009@s.whatsapp.net" }],
    ["an id that is not a message id", { id: "../x" }],
    ["an id the chat does not have", { id: "NOSUCHMESSAGE" }],
    ["an emoji that is not one", { emoji: "like" }],
    ["an emoji and remove", { remove: true }],
    ["neither an emoji nor remove", { emoji: undefined }],
  ])("gives no description for %s", async (_what, args) => {
    expect(await describeCall(args)).toBeUndefined()
  })

  test("gives no description for a message of a reaction, a vote or a group message with no author", async () => {
    t.setUp({
      mirror: {
        chats: [wacliChat({ jid: ALICE }), wacliChat({ jid: TEAM, kind: "group" })],
        messages: [
          messageRow({ id: "REACTION", Text: "", ReactionEmoji: "👍", ReactionToID: MESSAGE_ID }),
          messageRow({ id: "VOTE", Text: "Poll vote" }),
          messageRow({ id: "NOAUTHOR", chat: TEAM, SenderJID: "" }),
        ],
      },
    })
    expect(await describeCall({ id: "REACTION" })).toBeUndefined()
    expect(await describeCall({ id: "VOTE" })).toBeUndefined()
    expect(await describeCall({ chat: TEAM, id: "NOAUTHOR" })).toBeUndefined()
  })

  test("only reads: every wacli call carries --read-only, and nothing is reacted to", async () => {
    await describeCall({})
    const calls = await t.wacliCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.argv).toContain("--read-only")
    expect(await t.reactCalls()).toEqual([])
  })

  test("gives the same answer for the same state, so that the approval pins it", async () => {
    expect(await describeCall({})).toEqual(await describeCall({}))
  })

  test("has Japanese words for its headlines", async () => {
    const ja = translator(REACT_TRANSLATIONS, "ja")
    expect(ja.template(REACT_WORDS.headline)).toBe("{chat} で {emoji} のリアクションを付けようとしています")
    expect(ja.template(REACT_WORDS.removeHeadline)).toBe("{chat} で自分のリアクションを外そうとしています")
  })
})
