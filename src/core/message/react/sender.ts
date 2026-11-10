import { withoutDevice } from "../../chat/jid"
import type { WacliMessage } from "../../chat/rows"
import { ToolError } from "../../errors"

const UNKNOWN_AUTHOR =
  "The mirror does not say who wrote this message, and WhatsApp needs its author to address a reaction. Nothing was changed."

/** Stands for the JID of the account itself, which only the account's own store tells. */
export const OWN_JID = Symbol("own jid")

/** Who WhatsApp is told wrote the message: nobody, a JID, or the account itself. */
export type ReactionSender = string | typeof OWN_JID | undefined

/**
 * The author WhatsApp needs to address a reaction to the message `row` of `chat`, or undefined when it is not needed:
 * with no sender it addresses the user's own message, which is all a person's chat holds of the user's. In a group
 * the author is always named: the one the mirror has, or `OWN_JID` for the user's own message when the mirror has
 * none, which is how wacli stores what it sent itself. For someone else's message in a person's chat the author is
 * the chat itself when the mirror has none. `upstream_error` when the mirror does not say who wrote someone else's.
 */
export function reactionSender(row: WacliMessage, chat: string, kind: "person" | "group"): ReactionSender {
  if (row.FromMe && kind === "person") return undefined
  const author = row.SenderJID.trim() || (!row.FromMe && kind === "person" ? chat : "")
  if (author !== "") return withoutDevice(author)
  if (row.FromMe) return OWN_JID
  throw new ToolError("upstream_error", UNKNOWN_AUTHOR)
}
