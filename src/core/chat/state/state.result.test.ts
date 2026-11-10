import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { MS_PER_MINUTE } from "../../time"
import { ALICE, TEAM } from "../read.testing"
import { whatsappChatArchive } from "./archive"
import { whatsappChatMute } from "./mute"
import { whatsappChatPin } from "./pin"
import { chatsArgv, createStateTest, type StateTest } from "./state.testing"

let t: StateTest

beforeEach(async () => {
  t = await createStateTest()
  await t.serve()
})

afterEach(async () => {
  await t.close()
})

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const ACCEPTED = "Accepted by WhatsApp. Only the user's own devices show this; nobody in the chat learns of it."

/** The `chats` arguments, after `--timeout 60s --chat <chat>`, the one change of the fake got. */
async function sentFlags(): Promise<string[]> {
  const [call, ...others] = await t.changeCalls()
  expect(others).toEqual([])
  const argv = chatsArgv(call!)
  expect(argv.slice(2, 4)).toEqual(["--timeout", "60s"])
  return [argv[1]!, ...argv.slice(6)]
}

describe("what each value sends through the service", () => {
  test.each([
    [whatsappChatArchive, { archived: true }, ["archive"]],
    [whatsappChatArchive, { archived: false }, ["unarchive"]],
    [whatsappChatPin, { pinned: true }, ["pin"]],
    [whatsappChatPin, { pinned: false }, ["unpin"]],
    [whatsappChatMute, { mute: "8_hours" }, ["mute", "--duration", "8h"]],
    [whatsappChatMute, { mute: "1_week" }, ["mute", "--duration", "168h"]],
    [whatsappChatMute, { mute: "always" }, ["mute", "--duration", "0"]],
    [whatsappChatMute, { mute: "off" }, ["unmute"]],
  ])("%o %o runs wacli chats %p for the chat, without --read-only", async (tool, change, command) => {
    await t.run(tool, { chat: "15550100001:7@s.whatsapp.net", ...change })
    expect(await sentFlags()).toEqual(command)
    const [call] = await t.changeCalls()
    expect(call!.argv).not.toContain("--read-only")
    expect(call!.argv[call!.argv.indexOf("--chat") + 1]).toBe(ALICE)
  })
})

describe("the result of an archiving", () => {
  test("names the chat, the state, the time it was accepted in local time, and who sees it", async () => {
    const before = Date.now()
    const result = await t.run(whatsappChatArchive, { chat: ALICE, archived: false })
    expect(result).toEqual({ chat: ALICE, archived: false, time: expect.stringMatching(LOCAL_TIME), note: ACCEPTED })
    expect(Date.parse(result.time)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(result.time)).toBeLessThanOrEqual(Date.now())
  })

  test("says that archiving also unpins the chat, but not unarchiving", async () => {
    expect((await t.run(whatsappChatArchive, { chat: ALICE, archived: true })).note).toBe(
      `${ACCEPTED} Archiving also unpins the chat.`,
    )
    expect((await t.run(whatsappChatArchive, { chat: TEAM, archived: false })).note).toBe(ACCEPTED)
  })
})

describe("the result of a pinning", () => {
  test.each([true, false])("names the chat, the state %p and the time", async (pinned) => {
    expect(await t.run(whatsappChatPin, { chat: TEAM, pinned })).toEqual({
      chat: TEAM,
      pinned,
      time: expect.stringMatching(LOCAL_TIME),
      note: ACCEPTED,
    })
  })
})

describe("the result of a mute", () => {
  test.each([
    ["8_hours", 8 * MS_PER_HOUR],
    ["1_week", 7 * 24 * MS_PER_HOUR],
  ])("for %s says when the mute ends, counted from when it was accepted", async (mute, lasts) => {
    const result = await t.run(whatsappChatMute, { chat: ALICE, mute })
    expect(result).toEqual({
      chat: ALICE,
      mute,
      until: expect.stringMatching(LOCAL_TIME),
      time: expect.stringMatching(LOCAL_TIME),
      note: ACCEPTED,
    })
    expect(Date.parse(result.until) - Date.parse(result.time)).toBe(lasts)
  })

  test.each(["always", "off"])("for %s has no end time", async (mute) => {
    const result = await t.run(whatsappChatMute, { chat: ALICE, mute })
    expect(result).toEqual({ chat: ALICE, mute, time: expect.stringMatching(LOCAL_TIME), note: ACCEPTED })
    expect(result).not.toHaveProperty("until")
  })
})
