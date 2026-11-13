import { describe, expect, test } from "bun:test"
import { gateRefusal } from "../entry/gate"
import { ALL_TOOLS } from "../tools"
import { NO_SUCH_CHAT } from "./chat/mirror"
import { whatsappChatRead } from "./chat/read"
import { NOT_IN_MIRROR as NO_SUCH_HISTORY_CHAT } from "./history/backfill"
import { whatsappMessageSend } from "./message/send"
import { invoke, type ToolContext } from "./tool"

import { ARGUMENTS, GROUP, HIDDEN, MESSAGE_ID, PERSON, SENDS, chatTools } from "./tools.excluded.testing"

const DEVICE_PERSON = "14155550123:7@s.whatsapp.net"
const OTHER = "14155550999@s.whatsapp.net"

const READ = { code: "not_found", message: NO_SUCH_CHAT }
const ACTION = {
  code: "not_found",
  message:
    "This chat is not in this account's mirror. Find the chat with whatsapp_chat_read list. Nothing was changed.",
}
const HISTORY = { code: "not_found", message: NO_SUCH_HISTORY_CHAT }
const NOT_IN_MIRROR = {
  code: "not_found",
  message: expect.stringContaining("This chat is not in this account's mirror, and only a person's phone number"),
}
const NOTHING_TO_QUOTE = {
  code: "not_found",
  message: expect.stringContaining("so there is no message of it to reply to"),
}
const NO_ANSWER = {
  code: "upstream_error",
  message: expect.stringContaining("WhatsApp gave no answer on whether this number has an account"),
}

const ctx: ToolContext = {
  cwd: "/unavailable",
  options: { exclude_chats: [PERSON, HIDDEN, GROUP] },
  get stateDir(): string {
    throw new Error("The gate must not open the mirror or contact the service")
  },
}

/** `ctx` with another `exclude_chats` value, keeping the state directory that throws. */
function withSetting(chats: unknown): ToolContext {
  return Object.assign(Object.create(ctx), { options: { exclude_chats: chats } })
}

/** What each tool gives for an excluded chat, which is what it gives for a chat the mirror does not hold. */
const UNKNOWN: Record<string, unknown> = {
  whatsapp_chat_read: READ,
  whatsapp_file_save: READ,
  whatsapp_history_backfill: HISTORY,
}

const tools = chatTools

describe("chat exclusion gates", () => {
  test("every tool that names a chat has a gate and arguments here", () => {
    expect(tools.length).toBe(Object.keys(ARGUMENTS).length)
    for (const spec of tools) {
      expect(spec.gate).toBeFunction()
      expect(ARGUMENTS[spec.id]).toBeDefined()
    }
  })

  for (const spec of tools.filter(({ id }) => !SENDS.includes(id))) {
    const unknown = UNKNOWN[spec.id] ?? ACTION

    for (const chat of [PERSON, HIDDEN, GROUP]) {
      test(`${spec.id} refuses ${chat} as an unknown chat, before anything runs`, async () => {
        const args = { ...ARGUMENTS[spec.id], chat }
        expect(spec.input.strict().safeParse(args).success).toBe(true)
        expect(await gateRefusal(spec, args, ctx)).toMatchObject(unknown)
        await expect(invoke(spec, args, ctx)).rejects.toMatchObject(unknown)
      })
    }

    test(`${spec.id} refuses a device-suffixed JID of an excluded person`, async () => {
      expect(await gateRefusal(spec, { ...ARGUMENTS[spec.id], chat: DEVICE_PERSON }, ctx)).toMatchObject(unknown)
    })
  }

  for (const spec of tools) {
    test(`${spec.id} lets a chat that is not excluded through the gate`, async () => {
      expect(await gateRefusal(spec, { ...ARGUMENTS[spec.id], chat: OTHER }, ctx)).toBeUndefined()
    })

    test(`${spec.id} fails closed on a malformed setting without echoing it`, async () => {
      const refusal = await gateRefusal(spec, { ...ARGUMENTS[spec.id], chat: OTHER }, withSetting(["private-secret"]))
      expect(refusal?.code).toBe("invalid_argument")
      expect(refusal?.message).toContain("exclude_chats")
      expect(refusal?.message).not.toContain("private-secret")
    })
  }

  for (const id of SENDS) {
    const spec = tools.find((candidate) => candidate.id === id)!
    const base = ARGUMENTS[id]

    describe(`${id} refuses as an unknown recipient, without asking WhatsApp`, () => {
      const cases: [string, Record<string, unknown>, unknown][] = [
        ["a group", { chat: GROUP }, NOT_IN_MIRROR],
        ["a hidden-number contact", { chat: HIDDEN }, NOT_IN_MIRROR],
        ["a phone JID", { chat: PERSON }, NO_ANSWER],
        ["a device-suffixed phone JID", { chat: DEVICE_PERSON }, NO_ANSWER],
        ["a phone JID with reply_to", { chat: PERSON, reply_to: MESSAGE_ID }, NOTHING_TO_QUOTE],
        ["a group with reply_to", { chat: GROUP, reply_to: MESSAGE_ID }, NOT_IN_MIRROR],
      ]
      for (const [name, extra, expected] of cases) {
        test(name, async () => {
          const args = { ...base, ...extra }
          expect(await gateRefusal(spec, args, ctx)).toMatchObject(expected as object)
          await expect(invoke(spec, args, ctx)).rejects.toMatchObject(expected as object)
        })
      }
    })

    test(`${id} gives a channel the refusal of any channel`, async () => {
      const channel = withSetting(["0029Va1B2c3D4e5F@newsletter"])
      const args = { ...base, chat: "0029Va1B2c3D4e5F@newsletter" }
      expect(await gateRefusal(spec, args, channel)).toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("Sends go to people and groups only"),
      })
    })
  }

  test("an excluded channel gets the refusal an action on any channel gets", async () => {
    const spec = tools.find(({ id }) => id === "whatsapp_chat_pin")!
    const channel = withSetting(["0029Va1B2c3D4e5F@newsletter"])
    const args = { ...ARGUMENTS.whatsapp_chat_pin, chat: "0029Va1B2c3D4e5F@newsletter" }
    expect(await gateRefusal(spec, args, channel)).toMatchObject({ code: "invalid_argument" })
  })

  test.each(["view", "around", "search"])("chat read %s refuses an excluded chat", async (method) => {
    const args = {
      method,
      chat: PERSON,
      ...(method === "around" ? { id: MESSAGE_ID } : {}),
      ...(method === "search" ? { query: "hello" } : {}),
    }
    expect(await gateRefusal(whatsappChatRead, args, ctx)).toMatchObject(READ)
  })

  test("chat read list and search across chats pass, but fail closed on a malformed setting", async () => {
    const malformed = withSetting([7])
    for (const args of [{ method: "list" }, { method: "search", query: "hello" }]) {
      expect(await gateRefusal(whatsappChatRead, args, ctx)).toBeUndefined()
      expect(await gateRefusal(whatsappChatRead, args, malformed)).toMatchObject({ code: "invalid_argument" })
    }
  })

  test("contact read names no chat but fails closed on a malformed setting", async () => {
    const spec = ALL_TOOLS.find(({ id }) => id === "whatsapp_contact_read")!
    const args = { method: "search", query: "ann" }
    expect(await gateRefusal(spec, args, ctx)).toBeUndefined()
    expect(await gateRefusal(spec, args, withSetting("nonsense"))).toMatchObject({ code: "invalid_argument" })
  })

  test("a message id is never taken for a chat", async () => {
    const react = ALL_TOOLS.find(({ id }) => id === "whatsapp_message_react")!
    expect(await gateRefusal(react, { chat: OTHER, id: PERSON, emoji: "👍" }, ctx)).toBeUndefined()
    const send = ALL_TOOLS.find(({ id }) => id === whatsappMessageSend.id)!
    expect(await gateRefusal(send, { chat: OTHER, text: "hi", reply_to: PERSON }, ctx)).toBeUndefined()
  })
})
