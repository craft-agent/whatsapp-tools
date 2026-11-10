import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  ALICE,
  HIDDEN,
  LABEL,
  NEWS,
  TEAM,
  at,
  createChatFixture,
  wacliChat,
  wacliMessage,
  type ChatFixture,
} from "../chat/read.testing"
import { openMirror, type Mirror } from "../chat/mirror"
import { ToolError } from "../errors"
import { MS_PER_MINUTE } from "../time"
import type { WacliMessage } from "../chat/rows"
import { labelPaths } from "../whatsapp/labels"
import { messageIdOf } from "./recipient"
import { actionChat, actionMessage, ownMessage } from "./target"
import { MESSAGE_WORDS } from "./words"

const ID = "3EB0A1B2C3D4E5F6"
const WINDOW_MS = 15 * MS_PER_MINUTE

let f: ChatFixture
let mirror: Mirror

beforeEach(async () => {
  f = await createChatFixture()
  mirror = openMirror(labelPaths(f.stateDir, LABEL), undefined)
})

afterEach(async () => {
  await f.close()
})

/** The error `run` rejects with. */
async function failureOf(run: () => unknown): Promise<ToolError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("expected a failure")
}

/** A row as the mirror reads it back, with `change` on top. */
async function rowWith(change: Record<string, unknown>): Promise<WacliMessage> {
  f.addChats(wacliChat({ jid: ALICE }))
  f.add({ id: ID, chat: ALICE, at: at(1), Text: "hello", ...change })
  return actionMessage(mirror, ALICE, ID)
}

describe("messageIdOf", () => {
  test("gives a message id as it is", () => {
    expect(messageIdOf(ID, "id")).toBe(ID)
  })

  test.each(["", "-x", "../x", "a b", "x".repeat(129)])(
    "refuses %p, naming the argument and not echoing it",
    async (given) => {
      const error = await failureOf(() => messageIdOf(given, "id"))
      expect(error.code).toBe("invalid_argument")
      expect(error.message.startsWith("id must be a message id")).toBe(true)
      if (given !== "") expect(error.message).not.toContain(given)
    },
  )
})

describe("actionChat", () => {
  beforeEach(() => {
    f.addChats(
      wacliChat({ jid: ALICE, name: "Alice" }),
      wacliChat({ jid: TEAM, kind: "group", name: "Team" }),
      wacliChat({ jid: HIDDEN, kind: "", name: "" }),
      wacliChat({ jid: NEWS, kind: "newsletter", name: "News" }),
    )
  })

  test("names a person and a group as the mirror does, with their Chat fact", async () => {
    expect(await actionChat(mirror, ALICE)).toEqual({
      name: "Alice",
      fact: { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.person } },
    })
    expect(await actionChat(mirror, TEAM)).toEqual({
      name: "Team",
      fact: { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.group } },
    })
  })

  test("names a chat the mirror gives no name by its number, else its JID", async () => {
    f.addChats(wacliChat({ jid: "15550100002@s.whatsapp.net" }))
    expect((await actionChat(mirror, "15550100002@s.whatsapp.net")).name).toBe("+15550100002")
    expect((await actionChat(mirror, HIDDEN)).name).toBe(HIDDEN)
  })

  test("is not_found for a chat the mirror lacks, pointing to the chat list", async () => {
    const error = await failureOf(() => actionChat(mirror, "15550100009@s.whatsapp.net"))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("whatsapp_chat_read list")
  })

  test("is invalid_argument for a channel", async () => {
    const error = await failureOf(() => actionChat(mirror, NEWS))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("people and groups only")
  })
})

describe("actionMessage", () => {
  test("gives the row of the message", async () => {
    const row = await rowWith({ FromMe: true })
    expect(row).toMatchObject({ MsgID: ID, Text: "hello", FromMe: true })
    expect(row).not.toHaveProperty("LocalPath")
  })

  test("is not_found for an id the chat does not have", async () => {
    f.addChats(wacliChat({ jid: ALICE }))
    const error = await failureOf(() => actionMessage(mirror, ALICE, "NOSUCHMESSAGE"))
    expect(error.code).toBe("not_found")
  })

  test("is not_found for a row wacli kept for traffic it could not read", async () => {
    const error = await failureOf(() => rowWith({ Text: "", DisplayText: "(message)" }))
    expect(error.code).toBe("not_found")
  })

  test.each([
    ["revoked", { Revoked: true }],
    ["deleted for the user", { DeletedForMe: true }],
  ])("is not_found for a message %s, saying it was deleted", async (_what, change) => {
    const error = await failureOf(() => rowWith(change))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("deleted")
  })

  test.each([
    ["a reacted-to id", { ReactionToID: "3EB0AAAAAAAAAAAA" }],
    ["an emoji", { ReactionEmoji: "👍", Text: "" }],
  ])("is invalid_argument for a reaction row (%s)", async (_what, change) => {
    const error = await failureOf(() => rowWith(change))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("reaction")
  })
})

describe("ownMessage", () => {
  const NOW = Date.UTC(2026, 10, 7, 6, 0, 0)
  const row = (change: Record<string, unknown>) => rowWith({ FromMe: true, ...change })
  const sentAgo = (ms: number) => ({ at: NOW - ms })

  test("lets through the user's message sent within the window, up to its last moment", async () => {
    f.addChats(wacliChat({ jid: ALICE }))
    f.add({ id: ID, chat: ALICE, FromMe: true, Text: "hello", ...sentAgo(WINDOW_MS) })
    const held = await actionMessage(mirror, ALICE, ID)
    expect(() => ownMessage(held, WINDOW_MS, "15 minutes", NOW)).not.toThrow()
  })

  test("is forbidden once the window has passed, saying the limit and that nothing was changed", async () => {
    f.addChats(wacliChat({ jid: ALICE }))
    f.add({ id: ID, chat: ALICE, FromMe: true, Text: "hello", ...sentAgo(WINDOW_MS) })
    const held = await actionMessage(mirror, ALICE, ID)
    const error = await failureOf(() => ownMessage(held, WINDOW_MS, "15 minutes", NOW + 1))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("15 minutes")
    expect(error.message).toContain("Nothing was changed")
  })

  test("is forbidden for someone else's message", async () => {
    const held = await rowWith({ FromMe: false })
    const error = await failureOf(() => ownMessage(held, WINDOW_MS, "15 minutes", Date.parse(held.Timestamp)))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("own messages")
  })

  test("measures from now unless told a time", async () => {
    const held = await row({ at: Date.now() - MS_PER_MINUTE })
    expect(() => ownMessage(held, WINDOW_MS, "15 minutes")).not.toThrow()
  })
})
