import { describe, expect, test } from "bun:test"
import type { WacliMessage } from "../../chat/rows"
import { ToolError } from "../../errors"
import { reactionSender } from "./sender"

const CHAT = "15550100001@s.whatsapp.net"
const TEAM = "120363000000000001@g.us"
const ME = "15550100000@s.whatsapp.net"
const AUTHOR = "15550100002@s.whatsapp.net"

/** Only the fields the function reads. */
const rowOf = (fromMe: boolean, senderJid: string) => ({ FromMe: fromMe, SenderJID: senderJid }) as WacliMessage

describe("reactionSender", () => {
  test("is none for the user's own message in a person's chat, whatever the mirror names", () => {
    expect(reactionSender(rowOf(true, ME), CHAT, "person")).toBeUndefined()
    expect(reactionSender(rowOf(true, ""), CHAT, "person")).toBeUndefined()
  })

  test("is the user's own JID for the user's own message in a group", () => {
    expect(reactionSender(rowOf(true, ME), TEAM, "group")).toBe(ME)
  })

  test("is the author the mirror names for someone else's message", () => {
    expect(reactionSender(rowOf(false, AUTHOR), CHAT, "person")).toBe(AUTHOR)
    expect(reactionSender(rowOf(false, AUTHOR), TEAM, "group")).toBe(AUTHOR)
  })

  test("is the chat itself for someone else's message in a person's chat when the mirror names none", () => {
    expect(reactionSender(rowOf(false, ""), CHAT, "person")).toBe(CHAT)
    expect(reactionSender(rowOf(false, "  "), CHAT, "person")).toBe(CHAT)
  })

  test("is trimmed, and without the device the JID names", () => {
    expect(reactionSender(rowOf(false, ` ${AUTHOR} `), TEAM, "group")).toBe(AUTHOR)
    expect(reactionSender(rowOf(false, "15550100002:12@s.whatsapp.net"), TEAM, "group")).toBe(AUTHOR)
    expect(reactionSender(rowOf(false, "99887766554433:3@lid"), TEAM, "group")).toBe("99887766554433@lid")
  })

  test.each([
    ["someone else's message in a group", false],
    ["the user's own message in a group", true],
  ])("is upstream_error for %s when the mirror names no author", (_what, fromMe) => {
    for (const blank of ["", "   "]) {
      const attempt = () => reactionSender(rowOf(fromMe, blank), TEAM, "group")
      expect(attempt).toThrow(ToolError)
      expect(attempt).toThrow(expect.objectContaining({ code: "upstream_error" }))
      expect(attempt).toThrow("does not say who wrote this message")
    }
  })
})
