import { ToolError } from "../errors"
import { fingerprint } from "../pages"
import type { ToolContext } from "../tool"
import { parseChatJid } from "./jid"

const INVALID_SETTING_MESSAGE =
  "The exclude_chats setting holds an entry that is not a chat JID; set it to chat JIDs as list gives them."

/** Whether `entry` is a chat JID exactly as `list` gives it: the form the tools accept, without a device suffix. */
function isCanonicalChatJid(entry: unknown): boolean {
  if (typeof entry !== "string") return false
  try {
    return parseChatJid(entry, "chat", "exclude_chats") === entry
  } catch {
    return false
  }
}

/**
 * The chats the `exclude_chats` setting keeps out of every tool; empty when it is unset. An entry that is not a chat
 * JID throws `invalid_argument` without repeating it, so a typo stops the tools instead of leaving a chat open.
 */
export function excludedChats(ctx: Pick<ToolContext, "options">): ReadonlySet<string> {
  const chats = ctx.options?.exclude_chats
  if (chats === undefined) return new Set()
  if (!Array.isArray(chats) || !chats.every(isCanonicalChatJid)) {
    throw new ToolError("invalid_argument", INVALID_SETTING_MESSAGE)
  }
  return new Set(chats)
}

/** Whether `excluded` holds the chat `jid` names, a person's device suffix ignored; a text that is no chat JID is not excluded. */
export function isExcluded(excluded: ReadonlySet<string>, jid: string): boolean {
  try {
    return excluded.has(parseChatJid(jid, "chat", "exclude_chats"))
  } catch {
    return false
  }
}

/** A digest of the excluded chats in a fixed order, so that a cursor binds the set and never carries a JID of it. */
export function excludedDigest(excluded: ReadonlySet<string>): string {
  return fingerprint([...excluded].sort())
}

/**
 * Throws `refusal` of the chat `chat` names when the setting excludes it. The refusal is the error the tool gives for
 * a chat it does not know, so an excluded chat cannot be told from an unknown one. The setting is checked even when
 * `chat` is undefined, and a `chat` that is no JID is left to the tool, which refuses it itself.
 */
export function refuseExcludedChat(
  ctx: Pick<ToolContext, "options">,
  chat: string | undefined,
  refusal: (chat: string) => ToolError,
): void {
  const excluded = excludedChats(ctx)
  if (chat === undefined || !isExcluded(excluded, chat)) return
  throw refusal(parseChatJid(chat, "chat", "exclude_chats"))
}
