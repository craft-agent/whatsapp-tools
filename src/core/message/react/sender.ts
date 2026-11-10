import type { WacliMessage } from "../../chat/rows"
import { ToolError } from "../../errors"

const UNKNOWN_AUTHOR =
  "The mirror does not say who wrote this message, and WhatsApp needs its author to address a reaction. Nothing was changed."

/** The device a JID names, which is no part of whose message it is. */
const DEVICE_SUFFIX = /:\d+(?=@)/

/**
 * The author WhatsApp needs to address a reaction to the message `row` of `chat`, or undefined when it is not needed:
 * with no sender it addresses the user's own message, which is all a person's chat holds of the user's. In a group
 * the author is always named (the user's own messages too), and for someone else's message in a person's chat the
 * author is the chat itself when the mirror has none. `upstream_error` when the mirror does not say who wrote it.
 */
export function reactionSender(row: WacliMessage, chat: string, kind: "person" | "group"): string | undefined {
  if (row.FromMe && kind === "person") return undefined
  const author = row.SenderJID.trim() || (!row.FromMe && kind === "person" ? chat : "")
  if (author === "") throw new ToolError("upstream_error", UNKNOWN_AUTHOR)
  return author.replace(DEVICE_SUFFIX, "")
}
