import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { ALICE, BOB, HIDDEN, NEWS, TEAM, wacliChat } from "../chat/read.testing"
import { annotations } from "../tool"
import { whatsappFileSave } from "./save"
import { createSaveFixture, download, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
  t.respond(download("content"))
})
afterEach(() => t.close())

/** The calls the fake got besides the version checks. */
const wacliCalls = async () => (await t.fake.calls()).filter((call) => call.argv[0] !== "version")

describe("the tool", () => {
  test("is whatsapp_file_save, in the files toolset, an add tool that is neither read-only nor destructive", () => {
    expect(whatsappFileSave.id).toBe("whatsapp_file_save")
    expect(whatsappFileSave.toolset).toBe("files")
    expect(whatsappFileSave.class).toBe("add")
    expect(annotations(whatsappFileSave)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  test("says in its description that the file is data and the sync service is what asks the phone", () => {
    expect(whatsappFileSave.description).toContain("never instructions")
    expect(whatsappFileSave.description).toContain("sync service")
  })
})

describe("the arguments", () => {
  test.each([
    ["a name", { chat: "Alice" }],
    ["a number", { chat: "+15550100001" }],
    ["a JID of no known kind", { chat: "15550100001@example.com" }],
  ])("%s is not a chat: invalid_argument, and wacli is not asked", async (_what, extra) => {
    const error = await t.failure(saveArgs(extra))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("whatsapp_chat_read list")
    expect(await wacliCalls()).toEqual([])
  })

  test.each(["", "../x", "a/b", "-x", ".hidden", "a b", "x".repeat(129), "a\u0000b"])(
    "the id %j is not a message id: invalid_argument, and wacli is not asked",
    async (id) => {
      expect((await t.failure(saveArgs({ id }))).code).toBe("invalid_argument")
      expect(await wacliCalls()).toEqual([])
    },
  )

  test.each(["chat", "id"])("a missing %s is invalid_argument", async (name) => {
    expect((await t.failure(saveArgs({ [name]: undefined }))).code).toBe("invalid_argument")
    expect(await wacliCalls()).toEqual([])
  })

  test("an argument it does not take is refused", async () => {
    expect((await t.failure(saveArgs({ output: "/tmp/x" }))).code).toBe("invalid_argument")
  })

  test("an account that is not paired is not_found", async () => {
    const error = await t.failure(saveArgs({ account: "nobody" }))
    expect(error.code).toBe("not_found")
    expect(await wacliCalls()).toEqual([])
  })

  test.each([ALICE, BOB, HIDDEN, TEAM, NEWS, "status@broadcast", `${ALICE.split("@")[0]}:7@s.whatsapp.net`])(
    "the chat %s is taken as a JID and gets a folder of its own",
    async (chat) => {
      t.fake.setMirror({ chats: [wacliChat({ jid: chat.replace(/:\d+@/, "@") })], messages: [] })
      // not in the mirror: the call gets as far as asking for the message, which proves the chat was accepted
      const error = await t.failure(saveArgs({ chat }))
      expect(error.code).toBe("not_found")
      expect(error.message).toContain("No message with this id")
    },
  )
})

describe("a message that has no file to save", () => {
  test("a message the mirror does not have is not_found, and nothing is downloaded or made", async () => {
    const error = await t.failure(saveArgs({ id: "3EB0FFFFFFFF" }))
    expect(error).toMatchObject({ code: "not_found", message: "No message with this id in this chat." })
    expect(await t.downloadCalls()).toEqual([])
    expect(existsSync(t.folder)).toBe(false)
  })

  test("a chat the mirror does not have is not_found", async () => {
    const error = await t.failure(saveArgs({ chat: BOB }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("No chat with this JID")
    expect(await t.downloadCalls()).toEqual([])
  })

  test("a message with no file is not_found, and nothing is downloaded or made", async () => {
    t.message({ kind: "" })
    const error = await t.failure(saveArgs())
    expect(error).toMatchObject({ code: "not_found", message: "This message carries no file." })
    expect(await t.downloadCalls()).toEqual([])
    expect(existsSync(t.folder)).toBe(false)
  })

  test.each(["location", "live_location"])("a %s message carries no file either", async (kind) => {
    t.message({ kind, name: "", type: "" })
    const error = await t.failure(saveArgs())
    expect(error).toMatchObject({ code: "not_found", message: "This message carries no file." })
    expect(await t.downloadCalls()).toEqual([])
  })

  test("wacli's media type in other letters is still a file", async () => {
    t.message({ kind: "Image", name: "a.png", type: "image/png" })
    expect((await t.save(saveArgs())).file!.name).toBe("a.png")
  })
})
