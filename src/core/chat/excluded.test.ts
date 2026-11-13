import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { excludedChats, isExcluded, refuseExcludedChat } from "./excluded"

const PERSON = "14155550123@s.whatsapp.net"
const HIDDEN = "98765432101234@lid"
const GROUP = "120363012345678901@g.us"
const OLD_GROUP = "14155550123-1600000000@g.us"
const CHANNEL = "0029Va1B2c3D4e5F@newsletter"
const STATUS = "status@broadcast"
const SETTING_MESSAGE =
  "The exclude_chats setting holds an entry that is not a chat JID; set it to chat JIDs as list gives them."

const unknown = () => new ToolError("not_found", "unknown")

describe("excluded chats", () => {
  test("defaults to none and keeps each distinct chat once", () => {
    expect([...excludedChats({})]).toEqual([])
    expect([...excludedChats({ options: { exclude_chats: [] } })]).toEqual([])
    expect([
      ...excludedChats({ options: { exclude_chats: [PERSON, HIDDEN, GROUP, OLD_GROUP, CHANNEL, STATUS, PERSON] } }),
    ]).toEqual([PERSON, HIDDEN, GROUP, OLD_GROUP, CHANNEL, STATUS])
  })

  test.each([
    "",
    "private",
    "+14155550123",
    "14155550123",
    "14155550123:12@s.whatsapp.net",
    ` ${PERSON}`,
    `${GROUP} `,
    "abc@s.whatsapp.net",
    "123@example.org",
  ])("refuses setting entry %j without showing it", (chat) => {
    expect(() => excludedChats({ options: { exclude_chats: [chat] } })).toThrow(
      new ToolError("invalid_argument", SETTING_MESSAGE),
    )
  })

  test("refuses a setting that is not a list of strings", () => {
    for (const setting of [PERSON, true, 7, [7 as unknown as string]]) {
      expect(() => excludedChats({ options: { exclude_chats: setting } })).toThrow(
        expect.objectContaining({ code: "invalid_argument", message: SETTING_MESSAGE }),
      )
    }
  })

  test("tells an excluded chat by its JID, ignoring a person's device suffix", () => {
    const excluded = excludedChats({ options: { exclude_chats: [PERSON, GROUP] } })
    expect(isExcluded(excluded, PERSON)).toBe(true)
    expect(isExcluded(excluded, "14155550123:7@s.whatsapp.net")).toBe(true)
    expect(isExcluded(excluded, GROUP)).toBe(true)
    expect(isExcluded(excluded, HIDDEN)).toBe(false)
    expect(isExcluded(excluded, "not a jid")).toBe(false)
  })

  test("throws the supplied refusal, with the normalized JID, for an excluded chat only", () => {
    const refusal = unknown()
    const ctx = { options: { exclude_chats: [PERSON, GROUP] } }
    expect(() => refuseExcludedChat(ctx, HIDDEN, () => refusal)).not.toThrow()
    expect(() => refuseExcludedChat(ctx, "not a jid", () => refusal)).not.toThrow()
    expect(() => refuseExcludedChat(ctx, undefined, () => refusal)).not.toThrow()
    expect(() =>
      refuseExcludedChat(ctx, ` 14155550123:9@s.whatsapp.net `, (chat) => {
        expect(chat).toBe(PERSON)
        return refusal
      }),
    ).toThrow(refusal)
  })

  test("checks the setting even when no chat is named", () => {
    expect(() => refuseExcludedChat({ options: { exclude_chats: ["x"] } }, undefined, unknown)).toThrow(
      expect.objectContaining({ code: "invalid_argument" }),
    )
  })
})
