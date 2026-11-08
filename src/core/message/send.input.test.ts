import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeTargets } from "../targets"
import { annotations } from "../tool"
import { MESSAGE_TEXT_MAX_CHARACTERS } from "../whatsapp/send"
import { CHAT, createSendTest, REPLY_ID, type SendTest } from "./send.testing"
import { whatsappMessageSend } from "./send"

let t: SendTest

beforeEach(async () => {
  t = await createSendTest()
  await t.serve()
})

afterEach(async () => {
  await t.close()
})

/** The `--message` the one send of the fake got. */
async function sentText(): Promise<string | undefined> {
  const [call] = await t.sendCalls()
  return call?.argv[call.argv.indexOf("--message") + 1]
}

describe("the tool's definition", () => {
  test("is an add in the sends toolset", () => {
    expect(whatsappMessageSend.id).toBe("whatsapp_message_send")
    expect(whatsappMessageSend.toolset).toBe("sends")
    expect(whatsappMessageSend.class).toBe("add")
    expect(annotations(whatsappMessageSend)).toEqual({
      title: "Send a message",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  test("tells what a send is, what it needs and what to do when its outcome is not known", () => {
    const description = whatsappMessageSend.description
    expect(description).toContain("person or a group")
    expect(description).toContain("whatsapp_chat_read list")
    expect(description).toContain("whatsapp_contact_read check")
    expect(description).toContain("sync service running")
    expect(description).toContain(`at most ${MESSAGE_TEXT_MAX_CHARACTERS} characters`)
    expect(description).toContain("no link preview")
    expect(description).toContain("not that it was delivered or read")
    expect(description).toContain("ask the user before sending it again")
    expect(description).toContain("no read receipt")
  })

  test("describes every argument and every field of its result", () => {
    const undescribed = (shape: Record<string, { description?: string }>) =>
      Object.entries(shape)
        .filter(([, field]) => !field.description)
        .map(([name]) => name)
    expect(undescribed(whatsappMessageSend.input.shape)).toEqual([])
    expect(undescribed(whatsappMessageSend.output.shape)).toEqual([])
  })
})

describe("what the call writes to", () => {
  const targets = (args: unknown, ctx: { stateDir?: string } = { stateDir: t.fixture.stateDir }) =>
    writeTargets(whatsappMessageSend, args, { cwd: t.fixture.stateDir, ...ctx })

  test("is the account and the chat, a person by the JID without the device suffix", async () => {
    expect(await targets({ chat: CHAT, text: "hi" })).toEqual([`main/${CHAT}`])
    expect(await targets({ chat: "15550100001:7@s.whatsapp.net", text: "hi", account: "main" })).toEqual([
      `main/${CHAT}`,
    ])
  })

  test("is * when the chat is not a JID, the account is unknown or there is no state directory", async () => {
    expect(await targets({ chat: "Ann", text: "hi" })).toEqual(["*"])
    expect(await targets({ chat: CHAT, text: "hi", account: "other" })).toEqual(["*"])
    expect(await targets({ chat: CHAT, text: "hi" }, {})).toEqual(["*"])
  })
})

describe("arguments the tool refuses before it reads the mirror or asks the service", () => {
  test.each([
    ["a name for a chat", { chat: "Ann" }],
    ["a number for a chat", { chat: "+15550100001" }],
    ["a missing chat", { chat: undefined }],
    ["a missing text", { text: undefined }],
    ["a text that is blank", { text: " \n\t " }],
    ["a text with a NUL", { text: "a\0b" }],
    ["a reply_to that is not a message id", { reply_to: "../x" }],
    ["an argument it does not know", { preview: true }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["a broadcast list", { chat: "1555010000199@broadcast" }],
    ["the status feed", { chat: "status@broadcast" }],
  ])("refuses %s as invalid_argument", async (_name, change) => {
    const error = await t.failure({ chat: CHAT, text: "hi", ...change })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain("15550100001")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("says that sends go to people and groups only for a channel, a broadcast list and the status feed", async () => {
    for (const chat of ["120363000000000002@newsletter", "status@broadcast"]) {
      const error = await t.failure({ chat, text: "hi" })
      expect(error.message).toContain("people and groups only")
      expect(error.message).toContain("Nothing was sent")
    }
  })
})

describe("the text", () => {
  test("is trimmed and otherwise sent as it is", async () => {
    await t.run({ chat: CHAT, text: "  \n Hello,\n  world — 世界 \t\n" })
    expect(await sentText()).toBe("Hello,\n  world — 世界")
  })

  test(`takes ${MESSAGE_TEXT_MAX_CHARACTERS} characters counted as code points`, async () => {
    const text = "😀".repeat(MESSAGE_TEXT_MAX_CHARACTERS)
    await t.run({ chat: CHAT, text: `  ${text}  ` })
    expect(await sentText()).toBe(text)
  })

  test(`refuses ${MESSAGE_TEXT_MAX_CHARACTERS + 1} characters, saying the length and that splitting is the user's call`, async () => {
    const error = await t.failure({ chat: CHAT, text: "😀".repeat(MESSAGE_TEXT_MAX_CHARACTERS + 1) })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${MESSAGE_TEXT_MAX_CHARACTERS + 1} characters`)
    expect(error.message).toContain("only if the user agrees")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("refuses half of a character, which would arrive as another one", async () => {
    const error = await t.failure({ chat: CHAT, text: "hi \uD83D" })
    expect(error.code).toBe("invalid_argument")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("is quoted to the message reply_to names", async () => {
    await t.run({ chat: CHAT, text: "hi", reply_to: REPLY_ID })
    const [call] = await t.sendCalls()
    expect(call!.argv.slice(-3)).toEqual(["--no-preview", "--reply-to", REPLY_ID])
  })
})
