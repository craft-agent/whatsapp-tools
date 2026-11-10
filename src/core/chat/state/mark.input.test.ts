import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeTargets } from "../../targets"
import { annotations } from "../../tool"
import { ALICE, NEWS } from "../read.testing"
import { whatsappChatMark } from "./mark"
import { createStateTest, type StateTest } from "./state.testing"

let t: StateTest

beforeEach(async () => {
  t = await createStateTest()
  await t.serve()
})

afterEach(async () => {
  await t.close()
})

describe("the definition of whatsapp_chat_mark", () => {
  test("is an idempotent change in the actions toolset", () => {
    expect(whatsappChatMark.id).toBe("whatsapp_chat_mark")
    expect(whatsappChatMark.toolset).toBe("actions")
    expect(whatsappChatMark.class).toBe("idempotent")
    expect(annotations(whatsappChatMark)).toEqual({
      title: "Mark a chat read or unread",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("tells what it sets, who learns of it, what receipts do and what to do when its outcome is not known", () => {
    const description = whatsappChatMark.description
    expect(description).toContain("person's or a group's chat the mirror holds")
    expect(description).toContain("on the user's own devices; nobody in the chat learns of it")
    expect(description).toContain("`receipts: true`, only with `read: true` and only when the user asks for it")
    expect(description).toContain("up to 100 unread messages")
    expect(description).toContain("tells their senders")
    expect(description).toContain("Without `receipts`, nobody learns anything")
    expect(description).toContain("marking it read clears the phone's unread mark")
    expect(description).toContain("clears only the mirror's unread count")
    expect(description).toContain("the phone's unread mark may stay until the user opens the chat")
    expect(description).toContain("whatsapp_chat_read list")
    expect(description).toContain("sync service running")
    expect(description).toContain("`uncertain` means the change may have reached WhatsApp")
    expect(description).toContain("calling again with the same arguments is safe")
    expect(description).toContain("receipts that went out may go out again")
    expect(description).toContain("errors.record")
    expect(description).toContain("Only when the user asked for this change")
  })

  test("describes every argument and every field of its result", () => {
    const undescribed = (shape: Record<string, { description?: string }>) =>
      Object.entries(shape)
        .filter(([, field]) => !field.description)
        .map(([name]) => name)
    expect(undescribed(whatsappChatMark.input.shape)).toEqual([])
    expect(undescribed(whatsappChatMark.output.shape)).toEqual([])
  })
})

describe("what the call writes to", () => {
  const targets = (args: unknown, ctx: { stateDir?: string } = { stateDir: t.fixture.stateDir }) =>
    writeTargets(whatsappChatMark, args, { cwd: t.fixture.stateDir, ...ctx })

  test("is the account and the chat, a person by the JID without the device suffix", async () => {
    expect(await targets({ chat: ALICE, read: true })).toEqual([`main/${ALICE}`])
    expect(await targets({ chat: "15550100001:7@s.whatsapp.net", read: false, account: "main" })).toEqual([
      `main/${ALICE}`,
    ])
  })

  test("is * when the chat is not a JID, the account is unknown or there is no state directory", async () => {
    expect(await targets({ chat: "Ann", read: true })).toEqual(["*"])
    expect(await targets({ chat: ALICE, read: true, account: "other" })).toEqual(["*"])
    expect(await targets({ chat: ALICE, read: true }, {})).toEqual(["*"])
  })
})

describe("arguments the tool refuses before it reads the mirror or asks the service", () => {
  test.each([
    ["a name for a chat", { chat: "Ann" }],
    ["a number for a chat", { chat: "+15550100001" }],
    ["a missing chat", { chat: undefined }],
    ["a channel", { chat: NEWS }],
    ["the status feed", { chat: "status@broadcast" }],
    ["a missing read", { read: undefined }],
    ["a read that is text", { read: "yes" }],
    ["a receipts that is text", { receipts: "yes" }],
    ["an argument it does not know", { through_message_id: "3EB0A1B2C3D4E5F6" }],
  ])("refuses %s as invalid_argument", async (_what, bad) => {
    const error = await t.failure(whatsappChatMark, { chat: ALICE, read: true, ...bad })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain("15550100001")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("refuses receipts without read as invalid_argument, saying nothing was changed", async () => {
    const error = await t.failure(whatsappChatMark, { chat: ALICE, read: false, receipts: true })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("receipts only goes with read: true. Nothing was changed.")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("takes receipts: false with either value of read, and leaves receipts out as false", async () => {
    await t.run(whatsappChatMark, { chat: ALICE, read: false, receipts: false })
    await t.run(whatsappChatMark, { chat: ALICE, read: true })
    const argvs = (await t.changeCalls()).map((call) => call.argv.slice(call.argv.indexOf("chats")))
    expect(argvs.map(([, action]) => action)).toEqual(["mark-unread", "mark-read"])
    for (const argv of argvs) expect(argv).not.toContain("--receipts")
  })
})
