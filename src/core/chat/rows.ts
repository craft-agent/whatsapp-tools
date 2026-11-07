import { z } from "zod"
import { MS_PER_SECOND } from "../time"

/** What wacli shows for a row that has no content. */
const NO_CONTENT = "(message)"

/** A time wacli wrote as RFC 3339. */
const wacliTime = z.string().refine((text) => Number.isFinite(Date.parse(text)), "not a time")

const text = z.string().default("")
const flag = z.boolean().default(false)

/** One chat as `wacli chats list` and `chats show` print it. */
export const wacliChat = z.object({
  jid: z.string(),
  kind: text,
  name: text,
  last_message_ts: z.string().default(""),
  archived: flag,
  pinned: flag,
  muted_until: z.number().default(0),
  unread: flag,
  unread_count: z.number().default(0),
})

/** One chat as wacli prints it. */
export type WacliChat = z.infer<typeof wacliChat>

/** One message as `wacli messages list` prints it: Go field names, except the tagged ones. */
export const wacliMessage = z.object({
  MsgID: z.string(),
  SenderJID: text,
  SenderName: text,
  Timestamp: wacliTime,
  FromMe: flag,
  Text: text,
  DisplayText: text,
  quoted_msg_id: text,
  quoted_sender_jid: text,
  IsForwarded: flag,
  ReactionToID: text,
  ReactionEmoji: text,
  MediaType: text,
  MediaCaption: text,
  Filename: text,
  MimeType: text,
  Starred: flag,
  Edited: flag,
  Revoked: flag,
  DeletedForMe: flag,
})

/** One message as wacli prints it, without the paths and keys it keeps beside it. */
export type WacliMessage = z.infer<typeof wacliMessage>

/** One poll as `wacli polls list` prints it. */
export const wacliPoll = z.object({ msg_id: z.string(), question: text })

/** One call event as `wacli calls list` prints it. */
export const wacliCall = z.object({ msg_id: text })

/** The second (Unix time) a message was sent in, which is as finely as wacli stores it. */
export function messageSecond(row: WacliMessage): number {
  return Math.floor(Date.parse(row.Timestamp) / MS_PER_SECOND)
}

/**
 * Whether wacli kept the row for protocol traffic it could not read: no text, media, reaction or quote, so it
 * shows the placeholder. A reply with no text of its own still has its quote, so it is not one.
 */
export function isUnreadable(row: WacliMessage): boolean {
  return (
    row.DisplayText.trim() === NO_CONTENT &&
    row.Text === "" &&
    row.MediaType === "" &&
    row.ReactionEmoji === "" &&
    row.ReactionToID === "" &&
    row.quoted_msg_id === ""
  )
}
