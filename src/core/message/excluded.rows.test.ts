import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { findMessageFile } from "../chat/message-file"
import { NO_MESSAGE_IN_CHAT, openMirror, type Mirror } from "../chat/mirror"
import { ALICE, HIDDEN, LABEL, at, createChatFixture, wacliChat, type ChatFixture } from "../chat/read.testing"
import { ToolError } from "../errors"
import { invoke, type ToolContext, type ToolSpec } from "../tool"
import { labelPaths } from "../whatsapp/labels"
import { describeReply, replyFact } from "./describe"
import { whatsappMessageDelete } from "./delete/tool"
import { whatsappMessageEdit } from "./edit/tool"
import { checkRecipient } from "./recipient"
import { whatsappMessageReact } from "./react/tool"
import { whatsappMessageSend } from "./send"
import { actionMessage } from "./target"

/** A row of Alice's excluded phone JID that wacli returns for a read of her …@lid, which the setting leaves open. */
const FILED_UNDER_EXCLUDED = "3EB0ALICEPHONE001"
const ALLOWED = "3EB0ALICELID00001"
const MISSING = "3EB0NOSUCHMESSAGE1"

const EXCLUDED: ReadonlySet<string> = new Set([ALICE])

let t: ChatFixture
let mirror: Mirror

beforeEach(async () => {
  t = await createChatFixture()
  mirror = openMirror(labelPaths(t.stateDir, LABEL), undefined)
  t.addChats(wacliChat({ jid: HIDDEN, name: "Alice" }), wacliChat({ jid: ALICE, name: "Alice" }))
  t.mirror.aliases = [[ALICE, HIDDEN]]
  t.add(
    { id: ALLOWED, chat: HIDDEN, at: at(1), Text: "fine", FromMe: true },
    { id: FILED_UNDER_EXCLUDED, chat: ALICE, at: at(2), Text: "secret", FromMe: true, MediaType: "document" },
  )
})

afterEach(async () => {
  await t.close()
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

/** What a read of an id the chat does not hold says, which a row of an excluded chat has to say too. */
const NOT_HELD = { code: "not_found", message: NO_MESSAGE_IN_CHAT }

const context = (): ToolContext => ({
  cwd: t.stateDir,
  stateDir: t.stateDir,
  options: { exclude_chats: [ALICE] },
})

const run = (tool: ToolSpec<any, any>, args: Record<string, unknown>) => invoke(tool, args, context())

describe("a message row filed under an excluded JID of the person asked for", () => {
  test("is not found for an action target, as a message the chat does not hold", async () => {
    const missing = await failureOf(() => actionMessage(mirror, EXCLUDED, HIDDEN, MISSING))
    const excluded = await failureOf(() => actionMessage(mirror, EXCLUDED, HIDDEN, FILED_UNDER_EXCLUDED))
    expect(excluded).toMatchObject(NOT_HELD)
    expect(excluded.message).toBe(missing.message)
    expect((await actionMessage(mirror, EXCLUDED, HIDDEN, ALLOWED)).MsgID).toBe(ALLOWED)
  })

  test("is not found for a file to save, as a message the chat does not hold", async () => {
    expect(await failureOf(() => findMessageFile(mirror, EXCLUDED, HIDDEN, FILED_UNDER_EXCLUDED))).toMatchObject(
      NOT_HELD,
    )
  })

  test("is not found for the message a reply quotes, in a prompt and in the send", async () => {
    expect(await failureOf(() => replyFact(mirror, EXCLUDED, HIDDEN, FILED_UNDER_EXCLUDED))).toMatchObject(NOT_HELD)
    const described = { name: "Alice", fact: { label: "Chat", value: "person" }, isNew: false }
    expect(
      await failureOf(() => describeReply(mirror, EXCLUDED, HIDDEN, described, FILED_UNDER_EXCLUDED)),
    ).toMatchObject(NOT_HELD)
    expect(
      await failureOf(() =>
        checkRecipient(labelPaths(t.stateDir, LABEL), EXCLUDED, HIDDEN, FILED_UNDER_EXCLUDED, undefined),
      ),
    ).toMatchObject(NOT_HELD)
    await checkRecipient(labelPaths(t.stateDir, LABEL), EXCLUDED, HIDDEN, ALLOWED, undefined)
  })

  test("stops each tool that works on a message before anything is asked of the service", async () => {
    const calls: [ToolSpec<any, any>, Record<string, unknown>][] = [
      [whatsappMessageSend, { chat: HIDDEN, text: "hi", reply_to: FILED_UNDER_EXCLUDED }],
      [whatsappMessageReact, { chat: HIDDEN, id: FILED_UNDER_EXCLUDED, emoji: "👍" }],
      [whatsappMessageEdit, { chat: HIDDEN, id: FILED_UNDER_EXCLUDED, text: "changed" }],
      [whatsappMessageDelete, { chat: HIDDEN, id: FILED_UNDER_EXCLUDED }],
    ]
    for (const [tool, args] of calls) {
      expect(await failureOf(() => run(tool, args))).toMatchObject(NOT_HELD)
    }
  })

  test("is found again when nothing is excluded", async () => {
    expect((await actionMessage(mirror, new Set(), HIDDEN, FILED_UNDER_EXCLUDED)).MsgID).toBe(FILED_UNDER_EXCLUDED)
    expect((await findMessageFile(mirror, new Set(), HIDDEN, FILED_UNDER_EXCLUDED)).kind).toBe("document")
  })
})
