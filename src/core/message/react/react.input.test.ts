import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeTargets } from "../../targets"
import { annotations } from "../../tool"
import { ACCEPTED, REFUSED } from "../emoji.testing"
import { CHAT, MESSAGE_ID, THUMBS_UP, createReactTest, type ReactTest } from "./react.testing"
import { whatsappMessageReact } from "./tool"

let t: ReactTest

beforeEach(async () => {
  t = await createReactTest()
  await t.serve()
})

afterEach(async () => {
  await t.close()
})

/** The `--reaction` the one reaction of the fake got. */
async function reactedWith(): Promise<string | undefined> {
  const [call] = await t.reactCalls()
  return call?.argv[call.argv.indexOf("--reaction") + 1]
}

describe("the tool's definition", () => {
  test("is an overwrite in the actions toolset", () => {
    expect(whatsappMessageReact.id).toBe("whatsapp_message_react")
    expect(whatsappMessageReact.toolset).toBe("actions")
    expect(whatsappMessageReact.class).toBe("overwrite")
    expect(annotations(whatsappMessageReact)).toEqual({
      title: "React to a message",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("tells what a reaction is, what it needs and what to do when its outcome is not known", () => {
    const description = whatsappMessageReact.description
    expect(description).toContain("exactly one emoji")
    expect(description).toContain("the user's own or someone else's")
    expect(description).toContain("`remove: true`")
    expect(description).toContain("replaces the user's earlier one")
    expect(description).toContain("whatsapp_chat_read")
    expect(description).toContain("sync service running")
    expect(description).toContain("not that it was delivered or seen")
    expect(description).toContain("read the chat with whatsapp_chat_read before reacting again")
    expect(description).toContain("errors.record")
    expect(description).toContain("Only when the user asked for this reaction")
  })

  test("describes every argument and every field of its result, and says emoji and remove go alone", () => {
    const undescribed = (shape: Record<string, { description?: string }>) =>
      Object.entries(shape)
        .filter(([, field]) => !field.description)
        .map(([name]) => name)
    expect(undescribed(whatsappMessageReact.input.shape)).toEqual([])
    expect(undescribed(whatsappMessageReact.output.shape)).toEqual([])
    for (const name of ["emoji", "remove"] as const) {
      expect(whatsappMessageReact.input.shape[name].description).toContain("never both and never neither")
    }
  })
})

describe("what the call writes to", () => {
  const targets = (args: unknown, ctx: { stateDir?: string } = { stateDir: t.fixture.stateDir }) =>
    writeTargets(whatsappMessageReact, args, { cwd: t.fixture.stateDir, ...ctx })

  test("is the account and the chat, a person by the JID without the device suffix", async () => {
    expect(await targets({ chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP })).toEqual([`main/${CHAT}`])
    expect(
      await targets({ chat: "15550100001:7@s.whatsapp.net", id: MESSAGE_ID, remove: true, account: "main" }),
    ).toEqual([`main/${CHAT}`])
  })

  test("is * when the chat is not a JID, the account is unknown or there is no state directory", async () => {
    expect(await targets({ chat: "Ann", id: MESSAGE_ID, emoji: THUMBS_UP })).toEqual(["*"])
    expect(await targets({ chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP, account: "other" })).toEqual(["*"])
    expect(await targets({ chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP }, {})).toEqual(["*"])
  })
})

describe("arguments the tool refuses before it reads the mirror or asks the service", () => {
  test.each([
    ["a name for a chat", { chat: "Ann" }],
    ["a number for a chat", { chat: "+15550100001" }],
    ["a missing chat", { chat: undefined }],
    ["a missing id", { id: undefined }],
    ["an id that is not a message id", { id: "../x" }],
    ["an argument it does not know", { preview: true }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["the status feed", { chat: "status@broadcast" }],
    ["an emoji and remove", { remove: true }],
    ["neither an emoji nor remove", { emoji: undefined }],
    ["remove: false and no emoji", { emoji: undefined, remove: false }],
    ["an empty emoji", { emoji: "" }],
    ["words for an emoji", { emoji: "like" }],
    ["two emoji", { emoji: `${THUMBS_UP}${THUMBS_UP}` }],
  ])("refuses %s as invalid_argument", async (_name, change) => {
    const error = await t.failure({ chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP, ...change })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain("15550100001")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("names the argument for an id that is not a message id, without echoing it", async () => {
    const error = await t.failure({ chat: CHAT, id: "../x", emoji: THUMBS_UP })
    expect(error.message).toContain("id must be a message id")
    expect(error.message).not.toContain("../x")
  })

  test("says to give emoji or remove when both or neither are given", async () => {
    const both = await t.failure({ chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP, remove: true })
    const neither = await t.failure({ chat: CHAT, id: MESSAGE_ID })
    for (const error of [both, neither]) {
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("exactly one of emoji")
      expect(error.message).toContain("Nothing was changed")
    }
  })

  test.each(REFUSED)("refuses %s as an emoji, saying so", async (_name, emoji) => {
    const error = await t.failure({ chat: CHAT, id: MESSAGE_ID, emoji })
    expect(error.code).toBe("invalid_argument")
    expect(await t.wacliCalls()).toEqual([])
  })
})

describe("the emoji", () => {
  test.each(ACCEPTED)("%s is reacted with as it is", async (_name, emoji) => {
    await t.run({ chat: CHAT, id: MESSAGE_ID, emoji })
    expect(await reactedWith()).toBe(emoji)
  })

  test("is an empty argument when the reaction is removed", async () => {
    await t.run({ chat: CHAT, id: MESSAGE_ID, remove: true })
    expect(await reactedWith()).toBe("")
  })

  test("is given with remove: false", async () => {
    await t.run({ chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP, remove: false })
    expect(await reactedWith()).toBe(THUMBS_UP)
  })
})
