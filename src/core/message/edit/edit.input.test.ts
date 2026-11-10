import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeTargets } from "../../targets"
import { annotations } from "../../tool"
import { MESSAGE_TEXT_MAX_CHARACTERS } from "../../whatsapp/send"
import { CHAT, MESSAGE_ID, createEditTest, type EditTest } from "./edit.testing"
import { whatsappMessageEdit } from "./tool"

let t: EditTest

beforeEach(async () => {
  t = await createEditTest()
  await t.serve()
})

afterEach(async () => {
  await t.close()
})

/** The `--message` the one edit of the fake got. */
async function editedText(): Promise<string | undefined> {
  const [call] = await t.editCalls()
  return call?.argv[call.argv.indexOf("--message") + 1]
}

describe("the tool's definition", () => {
  test("is an overwrite in the actions toolset", () => {
    expect(whatsappMessageEdit.id).toBe("whatsapp_message_edit")
    expect(whatsappMessageEdit.toolset).toBe("actions")
    expect(whatsappMessageEdit.class).toBe("overwrite")
    expect(annotations(whatsappMessageEdit)).toEqual({
      title: "Edit a message",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("tells what an edit is, its limits, what it needs and what to do when its outcome is not known", () => {
    const description = whatsappMessageEdit.description
    expect(description).toContain("the user sent")
    expect(description).toContain("at most 15 minutes")
    expect(description).toContain("only text messages")
    expect(description).toContain("whatsapp_chat_read")
    expect(description).toContain("sync service running")
    expect(description).toContain(`at most ${MESSAGE_TEXT_MAX_CHARACTERS} characters`)
    expect(description).toContain("marked as edited")
    expect(description).toContain("not that it was delivered or seen")
    expect(description).toContain("read the chat with whatsapp_chat_read before editing again")
    expect(description).toContain("errors.record")
    expect(description).toContain("Only when the user asked for this edit")
  })

  test("describes every argument and every field of its result", () => {
    const undescribed = (shape: Record<string, { description?: string }>) =>
      Object.entries(shape)
        .filter(([, field]) => !field.description)
        .map(([name]) => name)
    expect(undescribed(whatsappMessageEdit.input.shape)).toEqual([])
    expect(undescribed(whatsappMessageEdit.output.shape)).toEqual([])
  })
})

describe("what the call writes to", () => {
  const targets = (args: unknown, ctx: { stateDir?: string } = { stateDir: t.fixture.stateDir }) =>
    writeTargets(whatsappMessageEdit, args, { cwd: t.fixture.stateDir, ...ctx })

  test("is the account and the chat, a person by the JID without the device suffix", async () => {
    expect(await targets({ chat: CHAT, id: MESSAGE_ID, text: "hi" })).toEqual([`main/${CHAT}`])
    expect(
      await targets({ chat: "15550100001:7@s.whatsapp.net", id: MESSAGE_ID, text: "hi", account: "main" }),
    ).toEqual([`main/${CHAT}`])
  })

  test("is * when the chat is not a JID, the account is unknown or there is no state directory", async () => {
    expect(await targets({ chat: "Ann", id: MESSAGE_ID, text: "hi" })).toEqual(["*"])
    expect(await targets({ chat: CHAT, id: MESSAGE_ID, text: "hi", account: "other" })).toEqual(["*"])
    expect(await targets({ chat: CHAT, id: MESSAGE_ID, text: "hi" }, {})).toEqual(["*"])
  })
})

describe("arguments the tool refuses before it reads the mirror or asks the service", () => {
  test.each([
    ["a name for a chat", { chat: "Ann" }],
    ["a number for a chat", { chat: "+15550100001" }],
    ["a missing chat", { chat: undefined }],
    ["a missing id", { id: undefined }],
    ["an id that is not a message id", { id: "../x" }],
    ["a missing text", { text: undefined }],
    ["a text that is blank", { text: " \n\t " }],
    ["a text with a NUL", { text: "a\0b" }],
    ["half of a character", { text: "hi \uD83D" }],
    ["an argument it does not know", { preview: true }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["the status feed", { chat: "status@broadcast" }],
  ])("refuses %s as invalid_argument", async (_name, change) => {
    const error = await t.failure({ chat: CHAT, id: MESSAGE_ID, text: "hi", ...change })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain("15550100001")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("names the argument for an id that is not a message id, without echoing it", async () => {
    const error = await t.failure({ chat: CHAT, id: "../x", text: "hi" })
    expect(error.message).toContain("id must be a message id")
    expect(error.message).not.toContain("../x")
  })
})

describe("the text", () => {
  test("is trimmed and otherwise edited in as it is", async () => {
    await t.run({ chat: CHAT, id: MESSAGE_ID, text: "  \n See you at 7,\n  世界 \t\n" })
    expect(await editedText()).toBe("See you at 7,\n  世界")
  })

  test(`takes ${MESSAGE_TEXT_MAX_CHARACTERS} characters counted as code points`, async () => {
    const text = "😀".repeat(MESSAGE_TEXT_MAX_CHARACTERS)
    await t.run({ chat: CHAT, id: MESSAGE_ID, text: `  ${text}  ` })
    expect(await editedText()).toBe(text)
  })

  test(`refuses ${MESSAGE_TEXT_MAX_CHARACTERS + 1} characters, saying the length`, async () => {
    const error = await t.failure({
      chat: CHAT,
      id: MESSAGE_ID,
      text: "😀".repeat(MESSAGE_TEXT_MAX_CHARACTERS + 1),
    })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${MESSAGE_TEXT_MAX_CHARACTERS + 1} characters`)
    expect(error.message).toContain("Nothing was changed")
    expect(await t.wacliCalls()).toEqual([])
  })
})
