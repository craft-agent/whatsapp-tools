import { refuseExcludedChat } from "../chat/excluded"
import { chatKind } from "../chat/jid"
import type { Mirror } from "../chat/mirror"
import { isUnreadable, type WacliMessage } from "../chat/rows"
import { ToolError, isToolError } from "../errors"
import { ANY_TARGET } from "../targets"
import type { CallFact, ToolContext } from "../tool"
import { labelTargets } from "../whatsapp/label-targets"
import { chatDisplayName, chatKindFact } from "./describe"
import { chatOf, refusedServerError } from "./recipient"

const NOT_IN_MIRROR =
  "This chat is not in this account's mirror. Find the chat with whatsapp_chat_read list. Nothing was changed."

const PEOPLE_AND_GROUPS_ONLY =
  "Actions work on people and groups only: a channel, a broadcast list and the status feed are refused. Nothing was changed."

const NOT_YOURS = "Only the user's own messages can be changed. Nothing was changed."

const NO_SUCH_MESSAGE = "No message with this id in this chat. Nothing was changed."

const DELETED_MESSAGE = "The message was deleted, so it cannot be changed. Nothing was changed."

const REACTION_MESSAGE = "A reaction is not a message to act on. Nothing was changed."

/** The `gate` of an action tool: refuses an excluded chat as `actionChat` refuses one the mirror lacks, and a malformed setting. */
export function actionGate(args: { chat: string }, ctx: Pick<ToolContext, "options">): void {
  refuseExcludedChat(ctx, args.chat, (chat) => refusedServerError(chat) ?? new ToolError("not_found", NOT_IN_MIRROR))
}

/** The name and the `Chat` fact of the chat an action works on. */
export type ActionChat = { name: string; fact: CallFact }

/** The `targets` of an action tool `toolId`: what the call writes to, the account and the chat, or `*` when either cannot be told. */
export function actionTargets(
  toolId: string,
): (args: { chat?: string; account?: string }, ctx: ToolContext) => Promise<string[]> {
  return async (args, ctx) => {
    let chat: string
    try {
      chat = chatOf(args.chat, toolId)
    } catch {
      return [ANY_TARGET]
    }
    return labelTargets(ctx, args.account, chat)
  }
}

/**
 * The name and the `Chat` fact of the person's or group's chat an action works on, which the mirror must hold:
 * `not_found` for a chat it lacks, `invalid_argument` for any other kind of chat.
 */
export async function actionChat(mirror: Mirror, chat: string): Promise<ActionChat> {
  let row: Awaited<ReturnType<Mirror["chat"]>>
  try {
    row = await mirror.chat(chat)
  } catch (error) {
    if (isToolError(error) && error.code === "not_found") {
      throw new ToolError("not_found", NOT_IN_MIRROR, { cause: error })
    }
    throw error
  }
  const kind = chatKind(row.kind, chat)
  if (kind !== "person" && kind !== "group") throw new ToolError("invalid_argument", PEOPLE_AND_GROUPS_ONLY)
  return { name: chatDisplayName(chat, row.name), fact: chatKindFact(kind) }
}

/**
 * The row of the message `id` of `chat` that an action works on: one the mirror holds, readable and not deleted,
 * and not a reaction. `not_found` for a message that is missing, unreadable or deleted, `invalid_argument` for a reaction.
 */
export async function actionMessage(mirror: Mirror, chat: string, id: string): Promise<WacliMessage> {
  const row = (await mirror.context(chat, id, 0, 0)).find((candidate) => candidate.MsgID === id)
  if (!row || isUnreadable(row)) {
    throw new ToolError("not_found", NO_SUCH_MESSAGE)
  }
  if (row.Revoked || row.DeletedForMe) {
    throw new ToolError("not_found", DELETED_MESSAGE)
  }
  if (row.ReactionToID !== "" || row.ReactionEmoji !== "") {
    throw new ToolError("invalid_argument", REACTION_MESSAGE)
  }
  return row
}

/**
 * Lets an action through only for a message the user sent, no longer ago than `windowMs`; `what` says that limit in
 * words (`15 minutes`) for the refusal. `forbidden` otherwise.
 */
export function ownMessage(row: WacliMessage, windowMs: number, what: string, nowMs = Date.now()): void {
  if (!row.FromMe) throw new ToolError("forbidden", NOT_YOURS)
  if (nowMs - Date.parse(row.Timestamp) > windowMs) {
    throw new ToolError(
      "forbidden",
      `WhatsApp allows this only within ${what} of sending the message, and this one is older. Nothing was changed.`,
    )
  }
}
