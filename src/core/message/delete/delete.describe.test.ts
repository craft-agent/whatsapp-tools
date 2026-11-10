import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, NEWS, TEAM, wacliChat } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { MS_PER_MINUTE } from "../../time"
import { translator } from "../../words"
import { HISTORY_WORDS } from "../../history/words"
import { MESSAGE_WORDS } from "../words"
import {
  MESSAGE_ID,
  MESSAGE_TEXT,
  ago,
  createDeleteTest,
  minuteOf,
  ownMessageRow,
  type DeleteTest,
} from "./delete.testing"
import { whatsappMessageDelete } from "./tool"
import { DELETE_TRANSLATIONS, DELETE_WORDS } from "./words"

let t: DeleteTest

beforeEach(async () => {
  t = await createDeleteTest()
})

afterEach(async () => {
  await t.close()
})

const SENT_AT = ago(5 * MS_PER_MINUTE)

const PHOTO_ID = "3EB0DDDDDDDDDDDD"
const CAPTION_ID = "3EB0EEEEEEEEEEEE"

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
    ownMessageRow({ id: PHOTO_ID, at: SENT_AT, Text: "", MediaType: "image" }),
    ownMessageRow({ id: CAPTION_ID, at: SENT_AT, Text: "", MediaType: "image", MediaCaption: "Sunset" }),
  ],
}

const describeCall = (args: Record<string, unknown>) =>
  callDescription(
    whatsappMessageDelete,
    { id: MESSAGE_ID, ...args },
    { cwd: t.fixture.stateDir, stateDir: t.fixture.stateDir },
  )

describe("the description of a message deletion", () => {
  beforeEach(() => t.setUp({ mirror: MIRROR }))

  test("tells the chat, when the message was sent, its text, and that the sync pauses", async () => {
    expect(await describeCall({ chat: ALICE })).toEqual({
      headline: { text: DELETE_WORDS.headline, values: { chat: "Alice" } },
      facts: [
        { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.person } },
        { label: MESSAGE_WORDS.sentLabel, value: minuteOf(SENT_AT) },
        { label: MESSAGE_WORDS.textLabel, value: MESSAGE_TEXT },
        { label: HISTORY_WORDS.syncLabel, value: { text: DELETE_WORDS.syncPaused } },
      ],
    })
  })

  test("tells a photo with no caption by its kind", async () => {
    const description = await describeCall({ chat: ALICE, id: PHOTO_ID })
    expect(description?.facts[2]).toEqual({
      label: MESSAGE_WORDS.textLabel,
      value: { text: DELETE_WORDS.noText, values: { kind: "image" } },
    })
  })

  test("tells a photo with a caption by the caption", async () => {
    const description = await describeCall({ chat: ALICE, id: CAPTION_ID })
    expect(description?.facts[2]).toEqual({ label: MESSAGE_WORDS.textLabel, value: "Sunset" })
  })

  test("tells a group", async () => {
    const description = await describeCall({ chat: TEAM, id: "3EB0CCCCCCCCCCCC" })
    expect(description?.headline?.values).toEqual({ chat: "Team" })
    expect(description?.facts[0]).toEqual({ label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.group } })
  })

  test("names a person with no mirror name by the number", async () => {
    const description = await describeCall({ chat: BOB, id: "3EB0BBBBBBBBBBBB" })
    expect(description?.headline?.values).toEqual({ chat: "+15550100002" })
  })

  test("has no text section: the message is a fact", async () => {
    expect(await describeCall({ chat: ALICE })).not.toHaveProperty("text")
  })

  test.each([
    ["a name instead of a JID", { chat: "Alice" }],
    ["a channel", { chat: NEWS }],
    ["a chat the mirror lacks", { chat: "15550100009@s.whatsapp.net" }],
    ["an id that is not a message id", { chat: ALICE, id: "../x" }],
    ["an id the chat does not have", { chat: ALICE, id: "NOSUCHMESSAGE" }],
  ])("gives no description for %s", async (_what, args) => {
    expect(await describeCall(args)).toBeUndefined()
  })

  test("gives no description for a message that is not the user's, or too old", async () => {
    t.setUp({
      mirror: {
        chats: [wacliChat({ jid: ALICE })],
        messages: [
          ownMessageRow({ id: "THEIRS", FromMe: false }),
          ownMessageRow({ id: "TOOOLD", at: ago(49 * 60 * MS_PER_MINUTE) }),
        ],
      },
    })
    expect(await describeCall({ chat: ALICE, id: "THEIRS" })).toBeUndefined()
    expect(await describeCall({ chat: ALICE, id: "TOOOLD" })).toBeUndefined()
  })

  test("only reads: every wacli call carries --read-only, and nothing is deleted", async () => {
    await describeCall({ chat: ALICE })
    const calls = await t.wacliCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.argv).toContain("--read-only")
    expect(await t.deleteCalls()).toEqual([])
  })

  test("gives the same answer for the same state, so that the approval pins it", async () => {
    expect(await describeCall({ chat: ALICE })).toEqual(await describeCall({ chat: ALICE }))
  })

  test("has a Japanese headline and words for the facts it adds", async () => {
    const description = await describeCall({ chat: ALICE, id: PHOTO_ID })
    const ja = translator(DELETE_TRANSLATIONS, "ja")
    expect(ja.template(description!.headline!.text)).toBe("{chat} の自分のメッセージを全員から削除しようとしています")
    expect(ja.template(DELETE_WORDS.noText)).toBe("テキストのない{kind}")
    expect(ja.word(DELETE_WORDS.syncPaused)).toBe("この操作の間だけ一時停止")
  })
})
