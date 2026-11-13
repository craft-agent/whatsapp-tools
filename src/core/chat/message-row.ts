import { ToolError } from "../errors"
import { isExcluded } from "./excluded"
import { NO_MESSAGE_IN_CHAT, type Mirror } from "./mirror"
import type { WacliMessage } from "./rows"

/**
 * The row of the message `id` among those `mirror.context` gives for `chat`, or undefined when wacli's answer lacks
 * it. `mirror.context` itself is `not_found` for a message the chat does not hold; so is a row that wacli files
 * under an `excluded` JID of the same person, in the same words, so that it cannot be told from a missing one.
 */
export async function findMessageRow(
  mirror: Mirror,
  excluded: ReadonlySet<string>,
  chat: string,
  id: string,
): Promise<WacliMessage | undefined> {
  const row = (await mirror.context(chat, id, 0, 0)).find((candidate) => candidate.MsgID === id)
  if (row && isExcluded(excluded, row.ChatJID)) throw new ToolError("not_found", NO_MESSAGE_IN_CHAT)
  return row
}
