import { ToolError } from "../errors"
import { MESSAGE_ID_FORM } from "../whatsapp/media"
import { findMessageRow } from "./message-row"
import type { Mirror } from "./mirror"

/** wacli's media types of a message that carries a place, not a file. */
const PLACE_MEDIA_TYPES: ReadonlySet<string> = new Set(["location", "live_location"])

const NO_FILE = "This message carries no file."

/** What a message says of the file it carries. */
export type MessageFile = {
  /** wacli's media type: `image`, `video`, `audio`, `document`, `sticker`, … */
  kind: string
  /** The file name the sender gave it. */
  name?: string
  /** The content type the message declares. */
  type?: string
  /** Who sent the message: the sender's JID and mirror name (possibly empty), and whether the user sent it. */
  sender: { jid: string; name: string; fromMe: boolean }
}

/** The message id a call names, or `invalid_argument` when it cannot be one. The text is not echoed. */
export function parseMessageId(text: string): string {
  if (!MESSAGE_ID_FORM.test(text)) {
    throw new ToolError(
      "invalid_argument",
      "id must be a message id as whatsapp_chat_read gives it: letters, digits, `.`, `_` and `-`.",
    )
  }
  return text
}

/**
 * The file the message `id` of `chat` carries, read from the mirror. A chat or message the mirror does not have is
 * `not_found`, and so is a message that carries no file (a text, a place, a row wacli could not read) and one wacli
 * files under an `excluded` chat.
 */
export async function findMessageFile(
  mirror: Mirror,
  excluded: ReadonlySet<string>,
  chat: string,
  id: string,
): Promise<MessageFile> {
  await mirror.chat(chat)
  const row = await findMessageRow(mirror, excluded, chat, id)
  if (!row) throw new ToolError("upstream_error", "wacli returned a context without the message asked for.")
  const kind = row.MediaType.trim()
  if (kind === "" || PLACE_MEDIA_TYPES.has(kind.toLowerCase())) throw new ToolError("not_found", NO_FILE)
  return {
    kind,
    sender: { jid: row.SenderJID, name: row.SenderName, fromMe: row.FromMe },
    ...(row.Filename !== "" && { name: row.Filename }),
    ...(row.MimeType !== "" && { type: row.MimeType }),
  }
}
