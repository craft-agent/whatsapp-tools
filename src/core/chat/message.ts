import { formatLocalTime } from "../time"
import type { ChatKind } from "./jid"
import { capName } from "./names"
import { messageKind, type MessageKinds } from "./kinds"
import type { MessageEntry } from "./message-schema"
import type { WacliMessage } from "./rows"

/** The chat a message was read from. */
export type ChatContext = { id: string; kind: ChatKind }

/** What `from` says for the user's own messages. */
const ME = "me"

/** How wacli opens the display text of a reply: the quoted message, then the reply on a line of its own. */
const QUOTE_PREFIX = "> "

/** What wacli puts where the quoted message is not in its mirror. */
const UNKNOWN_QUOTE = "message"

/**
 * The text of the message a reply quotes, as wacli wrote it into the reply's display text
 * (`> <quoted>\n<the reply>`), or null when wacli did not have it. The reply's own text is told from the quote by
 * its end: the text itself when it has any, else the last line.
 */
function quotedText(row: WacliMessage): string | null {
  if (!row.DisplayText.startsWith(QUOTE_PREFIX)) return null
  const body = row.DisplayText.slice(QUOTE_PREFIX.length)
  const own = row.Text.trim()
  const end = own !== "" && body.endsWith(`\n${own}`) ? body.length - own.length - 1 : body.lastIndexOf("\n")
  const quoted = end > 0 ? body.slice(0, end) : ""
  return quoted === "" || quoted === UNKNOWN_QUOTE ? null : quoted
}

/** The sender's JID: the one wacli has, else the chat's own in a chat with one person. */
function senderJid(row: WacliMessage, chat: ChatContext): string {
  return row.SenderJID.trim() || (chat.kind === "person" ? chat.id : "")
}

/**
 * One message as a result carries it. Only what wacli reports is set, and never a path or a key. `kinds` says
 * which rows are polls and calls.
 */
export function toMessageEntry(row: WacliMessage, chat: ChatContext, kinds: MessageKinds): MessageEntry {
  const deleted = row.Revoked || row.DeletedForMe
  const name = capName(row.SenderName.trim())
  const entry: MessageEntry = {
    id: row.MsgID,
    time: formatLocalTime(Date.parse(row.Timestamp)),
    from: row.FromMe ? ME : name.text === "" ? null : name.text,
  }
  if (!row.FromMe && name.cut) entry.from_cut = true
  const sender = row.FromMe ? "" : senderJid(row, chat)
  if (sender !== "") entry.from_jid = sender
  if (row.Text !== "" && !deleted) entry.text = row.Text
  if (row.MediaType !== "") {
    entry.media = { kind: row.MediaType }
    if (row.Filename !== "") {
      const file = capName(row.Filename)
      entry.media.name = file.text
      if (file.cut) entry.media.name_cut = true
    }
    if (row.MimeType !== "") entry.media.mime = row.MimeType
    if (row.MediaCaption !== "") entry.media.caption = row.MediaCaption
  }
  if (row.quoted_msg_id !== "") {
    entry.reply_to = { id: row.quoted_msg_id, text: quotedText(row) }
    if (row.quoted_sender_jid !== "") entry.reply_to.from_jid = row.quoted_sender_jid
  }
  if (row.ReactionToID !== "" || row.ReactionEmoji !== "") {
    entry.reaction = { emoji: row.ReactionEmoji.trim() || null, to: row.ReactionToID }
  }
  if (row.Edited) entry.edited = true
  if (deleted) entry.deleted = true
  if (row.IsForwarded) entry.forwarded = true
  if (row.Starred) entry.starred = true
  const kind = messageKind(row, kinds)
  if (kind !== undefined) entry.kind = kind
  if (kind === "poll") entry.poll = { question: kinds.polls.get(row.MsgID) ?? "" }
  if (kind === "call") entry.call = { description: row.DisplayText.trim() }
  return entry
}
