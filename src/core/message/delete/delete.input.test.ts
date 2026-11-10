import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeTargets } from "../../targets"
import { annotations, toolMeta } from "../../tool"
import { CHAT, MESSAGE_ID, createDeleteTest, type DeleteTest } from "./delete.testing"
import { whatsappMessageDelete } from "./tool"

let t: DeleteTest

beforeEach(async () => {
  t = await createDeleteTest()
  await t.serve()
})

afterEach(async () => {
  await t.close()
})

describe("the tool's definition", () => {
  test("is administrative in the actions toolset, and asks the person even under an allow rule", () => {
    expect(whatsappMessageDelete.id).toBe("whatsapp_message_delete")
    expect(whatsappMessageDelete.toolset).toBe("actions")
    expect(whatsappMessageDelete.class).toBe("administrative")
    expect(annotations(whatsappMessageDelete)).toEqual({
      title: "Delete a message for everyone",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
    expect(toolMeta(whatsappMessageDelete)).toBeDefined()
  })

  test("tells what a deletion is, its limits, what it does to the service and what to do when its outcome is not known", () => {
    const description = whatsappMessageDelete.description
    expect(description).toContain("Deletes for everyone a message the user sent")
    expect(description).toContain("at most two days")
    expect(description).toContain("other people's messages cannot be deleted")
    expect(description).toContain("cannot be undone")
    expect(description).toContain("whatsapp_chat_read")
    expect(description).toContain("sync service running")
    expect(description).toContain("pauses syncing for the call")
    expect(description).toContain("`service_running` says whether it did")
    expect(description).toContain("not that it was delivered")
    expect(description).toContain("read the chat with whatsapp_chat_read before deleting again")
    expect(description).toContain("errors.record")
    expect(description).toContain("Only when the user asked to delete this very message")
  })

  test("describes every argument and every field of its result", () => {
    const undescribed = (shape: Record<string, { description?: string }>) =>
      Object.entries(shape)
        .filter(([, field]) => !field.description)
        .map(([name]) => name)
    expect(undescribed(whatsappMessageDelete.input.shape)).toEqual([])
    expect(undescribed(whatsappMessageDelete.output.shape)).toEqual([])
  })
})

describe("what the call writes to", () => {
  const targets = (args: unknown, ctx: { stateDir?: string } = { stateDir: t.fixture.stateDir }) =>
    writeTargets(whatsappMessageDelete, args, { cwd: t.fixture.stateDir, ...ctx })

  test("is the account and the chat, a person by the JID without the device suffix", async () => {
    expect(await targets({ chat: CHAT, id: MESSAGE_ID })).toEqual([`main/${CHAT}`])
    expect(await targets({ chat: "15550100001:7@s.whatsapp.net", id: MESSAGE_ID, account: "main" })).toEqual([
      `main/${CHAT}`,
    ])
  })

  test("is * when the chat is not a JID, the account is unknown or there is no state directory", async () => {
    expect(await targets({ chat: "Ann", id: MESSAGE_ID })).toEqual(["*"])
    expect(await targets({ chat: CHAT, id: MESSAGE_ID, account: "other" })).toEqual(["*"])
    expect(await targets({ chat: CHAT, id: MESSAGE_ID }, {})).toEqual(["*"])
  })
})

describe("arguments the tool refuses before it reads the mirror or asks the service", () => {
  test.each([
    ["a name for a chat", { chat: "Ann" }],
    ["a number for a chat", { chat: "+15550100001" }],
    ["a missing chat", { chat: undefined }],
    ["a missing id", { id: undefined }],
    ["an id that is not a message id", { id: "../x" }],
    ["an argument it does not know", { for_me: true }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["the status feed", { chat: "status@broadcast" }],
  ])("refuses %s as invalid_argument, and the sync child is never stopped", async (_name, change) => {
    const error = await t.failure({ chat: CHAT, id: MESSAGE_ID, ...change })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain("15550100001")
    expect(await t.wacliCalls()).toEqual([])
    expect(t.fixture.logs).not.toContain("event stopping")
    expect(await t.fixture.syncCalls()).toHaveLength(1)
  })

  test("names the argument for an id that is not a message id, without echoing it", async () => {
    const error = await t.failure({ chat: CHAT, id: "../x" })
    expect(error.message).toContain("id must be a message id")
    expect(error.message).not.toContain("../x")
  })
})
