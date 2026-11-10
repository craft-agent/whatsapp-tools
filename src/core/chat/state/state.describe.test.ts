import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../../describe"
import { MESSAGE_WORDS } from "../../message/words"
import type { ToolSpec } from "../../tool"
import { translator } from "../../words"
import { ALICE, BOB, NEWS, TEAM, wacliChat } from "../read.testing"
import { whatsappChatArchive } from "./archive"
import { whatsappChatMute } from "./mute"
import { whatsappChatPin } from "./pin"
import { createStateTest, HELD_MIRROR, type StateTest } from "./state.testing"
import { ARCHIVE_WORDS, CHAT_STATE_TRANSLATIONS, MUTE_WORDS, PIN_WORDS } from "./words"

let t: StateTest

beforeEach(async () => {
  t = await createStateTest()
  t.setUp({ mirror: { chats: [...HELD_MIRROR.chats!, wacliChat({ jid: NEWS, kind: "channel", name: "News" })] } })
})

afterEach(async () => {
  await t.close()
})

const describeCall = (tool: ToolSpec<any, any>, args: Record<string, unknown>) =>
  callDescription(tool, args, { cwd: t.fixture.stateDir, stateDir: t.fixture.stateDir })

const PERSON = { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.person } }
const GROUP = { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.group } }

describe("the description of an archiving", () => {
  test.each([
    [true, ARCHIVE_WORDS.archiveHeadline],
    [false, ARCHIVE_WORDS.unarchiveHeadline],
  ])("with archived %p tells the chat by the mirror's name, and nothing else", async (archived, text) => {
    expect(await describeCall(whatsappChatArchive, { chat: ALICE, archived })).toEqual({
      headline: { text, values: { chat: "Alice" } },
      facts: [PERSON],
    })
  })
})

describe("the description of a pinning", () => {
  test.each([
    [true, PIN_WORDS.pinHeadline],
    [false, PIN_WORDS.unpinHeadline],
  ])("with pinned %p tells the chat, and nothing else", async (pinned, text) => {
    expect(await describeCall(whatsappChatPin, { chat: TEAM, pinned })).toEqual({
      headline: { text, values: { chat: "Team" } },
      facts: [GROUP],
    })
  })

  test("gives no description for a pinning the tool would refuse for the limit, and one for an unpinning", async () => {
    const pinned = (jid: string) => wacliChat({ jid, name: jid, pinned: true })
    t.setUp({
      mirror: {
        chats: [
          pinned(BOB),
          pinned("15550100003@s.whatsapp.net"),
          pinned("15550100004@s.whatsapp.net"),
          ...HELD_MIRROR.chats!.slice(0, 1),
        ],
      },
    })
    expect(await describeCall(whatsappChatPin, { chat: ALICE, pinned: true })).toBeUndefined()
    expect(await describeCall(whatsappChatPin, { chat: ALICE, pinned: false })).toBeDefined()
  })
})

describe("the description of a mute", () => {
  test.each([
    ["8_hours", MUTE_WORDS.eightHours],
    ["1_week", MUTE_WORDS.oneWeek],
    ["always", MUTE_WORDS.always],
  ])("for %s tells the chat and how long, as a word of the tool's", async (mute, text) => {
    expect(await describeCall(whatsappChatMute, { chat: ALICE, mute })).toEqual({
      headline: { text: MUTE_WORDS.muteHeadline, values: { chat: "Alice" } },
      facts: [PERSON, { label: MUTE_WORDS.forLabel, value: { text } }],
    })
  })

  test("for off tells the chat only, and shows no end time", async () => {
    expect(await describeCall(whatsappChatMute, { chat: ALICE, mute: "off" })).toEqual({
      headline: { text: MUTE_WORDS.unmuteHeadline, values: { chat: "Alice" } },
      facts: [PERSON],
    })
  })
})

describe("every description", () => {
  const CALLS: [ToolSpec<any, any>, Record<string, unknown>][] = [
    [whatsappChatArchive, { archived: true }],
    [whatsappChatPin, { pinned: true }],
    [whatsappChatMute, { mute: "always" }],
  ]

  test.each(CALLS)("names a person with no mirror name by the number", async (tool, change) => {
    const description = await describeCall(tool, { chat: BOB, ...change })
    expect(description?.headline?.values).toEqual({ chat: "+15550100002" })
  })

  test.each(CALLS)("gives none for a call the tool would refuse", async (tool, change) => {
    for (const chat of ["Alice", NEWS, "15550100009@s.whatsapp.net"]) {
      expect(await describeCall(tool, { chat, ...change })).toBeUndefined()
    }
  })

  test.each(CALLS)(
    "has no text section, and only reads: every wacli call carries --read-only",
    async (tool, change) => {
      const description = await describeCall(tool, { chat: ALICE, ...change })
      expect(description).not.toHaveProperty("text")
      const calls = await t.wacliCalls()
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.argv).toContain("--read-only")
      expect(await t.changeCalls()).toEqual([])
    },
  )

  test.each(CALLS)("gives the same answer for the same state, so that the approval pins it", async (tool, change) => {
    const args = { chat: ALICE, ...change }
    expect(await describeCall(tool, args)).toEqual(await describeCall(tool, args))
  })

  test("has Japanese headlines for every value", async () => {
    const ja = translator(CHAT_STATE_TRANSLATIONS, "ja")
    expect(ja.template(ARCHIVE_WORDS.archiveHeadline)).toBe("{chat} をアーカイブしようとしています")
    expect(ja.template(ARCHIVE_WORDS.unarchiveHeadline)).toBe("{chat} のアーカイブを解除しようとしています")
    expect(ja.template(PIN_WORDS.pinHeadline)).toBe("{chat} をピン留めしようとしています")
    expect(ja.template(PIN_WORDS.unpinHeadline)).toBe("{chat} のピン留めを解除しようとしています")
    expect(ja.template(MUTE_WORDS.muteHeadline)).toBe("{chat} をミュートしようとしています")
    expect(ja.template(MUTE_WORDS.unmuteHeadline)).toBe("{chat} のミュートを解除しようとしています")
    expect(ja.word(MUTE_WORDS.forLabel)).toBe("期間")
    expect(ja.word(MUTE_WORDS.eightHours)).toBe("8 時間")
  })
})
