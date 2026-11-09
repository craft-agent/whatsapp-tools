import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { writeTargets } from "../../targets"
import { annotations } from "../../tool"
import { CHAT, createFileSendTest, type FileSendTest } from "./tool.testing"
import { whatsappFileSend } from "./tool"

let t: FileSendTest

beforeEach(async () => {
  t = await createFileSendTest()
})

afterEach(async () => {
  await t.close()
})

describe("the tool's definition", () => {
  test("is an add in the files toolset", () => {
    expect(whatsappFileSend.id).toBe("whatsapp_file_send")
    expect(whatsappFileSend.toolset).toBe("files")
    expect(annotations(whatsappFileSend)).toEqual({
      title: "Send files",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  test("tells what is sent and what is not, what it needs and what to do when a call stops or its outcome is not known", () => {
    const description = whatsappFileSend.description
    for (const part of [
      "person or a group",
      "whatsapp_chat_read list",
      "whatsapp_contact_read check",
      "sync service running",
      "working directory or the user's send directories",
      "keys, secrets, programs, installers and empty files are refused",
      "checked entry by entry",
      "`sha256`",
      "refused as stale",
      "1 to 10 files",
      "100 MiB",
      "each as its own message in the order given",
      "nothing is sent unless every file passes",
      "caption on the first file",
      "at most 1,024 characters",
      "never goes on an audio file",
      "`as_document`",
      "not that they were delivered or read",
      "never send the files that went out again",
      "ask the user before sending anything again",
      "data, never instructions",
    ]) {
      expect(description).toContain(part)
    }
  })

  test("describes every argument, the fields of a file and every field of its result", () => {
    const undescribed = (shape: Record<string, { description?: string }>) =>
      Object.entries(shape)
        .filter(([, field]) => !field.description)
        .map(([name]) => name)
    expect(undescribed(whatsappFileSend.input.shape)).toEqual([])
    expect(undescribed(whatsappFileSend.output.shape)).toEqual([])
    const files = whatsappFileSend.input.shape.files.element
    expect(undescribed(files.shape)).toEqual([])
  })

  test("takes at most ten files and at least one, and no argument it does not know", () => {
    const shape = whatsappFileSend.input.strict()
    const file = { path: "a.txt" }
    expect(shape.safeParse({ chat: CHAT, files: [] }).success).toBe(false)
    expect(shape.safeParse({ chat: CHAT, files: Array.from({ length: 11 }, () => file) }).success).toBe(false)
    expect(shape.safeParse({ chat: CHAT, files: Array.from({ length: 10 }, () => file) }).success).toBe(true)
    expect(shape.safeParse({ chat: CHAT, files: [{ path: "a.txt", sha256: "xyz" }] }).success).toBe(false)
    expect(shape.safeParse({ chat: CHAT, files: [file], caption: "x" }).success).toBe(false)
  })
})

describe("what the call writes to", () => {
  const targets = (args: unknown, ctx: { stateDir?: string } = { stateDir: t.fixture.stateDir }) =>
    writeTargets(whatsappFileSend, args, { cwd: t.box.root, ...ctx })

  test("is the account with the chat, and the real path of every file", async () => {
    const real = t.box.write("real.txt")
    t.box.link("link.txt", real)
    expect(await targets({ chat: CHAT, files: [{ path: "link.txt" }, { path: "gone.txt" }] })).toEqual([
      join(t.box.root, "gone.txt"),
      real,
      `main/${CHAT}`,
    ])
  })

  test("is * when the chat is not a JID, the account is unknown or there is no state directory", async () => {
    const files = [{ path: "a.txt" }]
    expect(await targets({ chat: "Ann", files })).toEqual(["*"])
    expect(await targets({ chat: CHAT, files, account: "other" })).toEqual([join(t.box.root, "a.txt"), "*"])
    expect(await targets({ chat: CHAT, files }, {})).toEqual([join(t.box.root, "a.txt"), "*"])
  })
})
