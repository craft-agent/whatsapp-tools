import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeTargets } from "../../targets"
import { annotations } from "../../tool"
import { ALICE, NEWS } from "../read.testing"
import { whatsappChatArchive } from "./archive"
import { whatsappChatMute } from "./mute"
import { whatsappChatPin } from "./pin"
import { createStateTest, type StateTest } from "./state.testing"

let t: StateTest

beforeEach(async () => {
  t = await createStateTest()
  await t.serve()
})

afterEach(async () => {
  await t.close()
})

/** Each tool, with its title, a phrase its description holds and the argument that sets its state. */
const TOOLS = [
  { tool: whatsappChatArchive, title: "Archive a chat", says: "also unpins", change: { archived: true } },
  { tool: whatsappChatPin, title: "Pin a chat", says: "at most three chats", change: { pinned: true } },
  { tool: whatsappChatMute, title: "Mute a chat", says: "`8_hours`, `1_week`, `always`", change: { mute: "8_hours" } },
]

for (const { tool, title, says, change } of TOOLS) {
  describe(tool.id, () => {
    test("is an idempotent change in the actions toolset", () => {
      expect(tool.toolset).toBe("actions")
      expect(tool.class).toBe("idempotent")
      expect(annotations(tool)).toEqual({
        title,
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      })
    })

    test("tells what it sets, where the chat comes from, what it needs and what to do when its outcome is not known", () => {
      expect(tool.description).toContain("person's or a group's chat the mirror holds")
      expect(tool.description).toContain(says)
      expect(tool.description).toContain("whatsapp_chat_read list")
      expect(tool.description).toContain("sync service running")
      expect(tool.description).toContain("Only the user's own devices show it; nobody in the chat learns of it")
      expect(tool.description).toContain("`uncertain` means the change may have reached WhatsApp")
      expect(tool.description).toContain("calling again with the same arguments is safe")
      expect(tool.description).toContain("Only when the user asked for this change")
    })

    test("describes every argument and every field of its result", () => {
      const undescribed = (shape: Record<string, { description?: string }>) =>
        Object.entries(shape)
          .filter(([, field]) => !field.description)
          .map(([name]) => name)
      expect(undescribed(tool.input.shape)).toEqual([])
      expect(undescribed(tool.output.shape)).toEqual([])
    })

    describe("what the call writes to", () => {
      const targets = (args: unknown, ctx: { stateDir?: string } = { stateDir: t.fixture.stateDir }) =>
        writeTargets(tool, args, { cwd: t.fixture.stateDir, ...ctx })

      test("is the account and the chat, a person by the JID without the device suffix", async () => {
        expect(await targets({ chat: ALICE, ...change })).toEqual([`main/${ALICE}`])
        expect(await targets({ chat: "15550100001:7@s.whatsapp.net", account: "main", ...change })).toEqual([
          `main/${ALICE}`,
        ])
      })

      test("is * when the chat is not a JID, the account is unknown or there is no state directory", async () => {
        expect(await targets({ chat: "Ann", ...change })).toEqual(["*"])
        expect(await targets({ chat: ALICE, account: "other", ...change })).toEqual(["*"])
        expect(await targets({ chat: ALICE, ...change }, {})).toEqual(["*"])
      })
    })

    describe("arguments refused before the mirror is read or the service is asked", () => {
      const refused: [string, Record<string, unknown>][] = [
        ["a name for a chat", { chat: "Ann" }],
        ["a number for a chat", { chat: "+15550100001" }],
        ["a missing chat", { chat: undefined }],
        ["a channel", { chat: NEWS }],
        ["the status feed", { chat: "status@broadcast" }],
        ["an argument it does not know", { duration: "8h" }],
        ...Object.keys(change).flatMap((name): [string, Record<string, unknown>][] => [
          [`a missing ${name}`, { [name]: undefined }],
          [`${name} that is text it does not offer`, { [name]: "yes" }],
        ]),
      ]
      test.each(refused)("refuses %s as invalid_argument", async (_what, bad) => {
        const error = await t.failure(tool, { chat: ALICE, ...change, ...bad })
        expect(error.code).toBe("invalid_argument")
        expect(error.message).not.toContain("15550100001")
        expect(await t.wacliCalls()).toEqual([])
      })
    })
  })
}

describe("the mute", () => {
  test.each(["24_hours", "8h", "forever", "", 8])("refuses %p, which the phone does not offer", async (mute) => {
    const error = await t.failure(whatsappChatMute, { chat: ALICE, mute })
    expect(error.code).toBe("invalid_argument")
    expect(await t.wacliCalls()).toEqual([])
  })
})
