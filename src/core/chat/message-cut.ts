import { cutText, type Cuttable } from "../pages"
import type { MessageEntry } from "./message-schema"

/**
 * The texts of a message in the order they are cut from the end: the text, the
 * caption, the quoted text, the poll's question, then the call's description.
 */
function texts(entry: MessageEntry): string[] {
  return [
    entry.text ?? "",
    entry.media?.caption ?? "",
    entry.reply_to?.text ?? "",
    entry.poll?.question ?? "",
    entry.call?.description ?? "",
  ]
}

/** How many characters of text a message carries, which is how much `cutMessage` can take from it. */
export function messageTextLength(entry: MessageEntry): number {
  return texts(entry).reduce((total, text) => total + text.length, 0)
}

/**
 * The message keeping `keep` characters of its texts, the earliest in the
 * order of `texts` first, and `text_cut` set when any lost something.
 */
export function cutMessage(entry: MessageEntry, keep: number): MessageEntry {
  let room = keep
  let cut = false
  const take = (text: string): string => {
    const kept = cutText(text, room)
    room = Math.max(0, room - text.length)
    if (kept.length < text.length) cut = true
    return kept
  }
  const cutEntry: MessageEntry = { ...entry }
  if (entry.text !== undefined) cutEntry.text = take(entry.text)
  if (entry.media?.caption !== undefined) cutEntry.media = { ...entry.media, caption: take(entry.media.caption) }
  if (entry.reply_to?.text != null) cutEntry.reply_to = { ...entry.reply_to, text: take(entry.reply_to.text) }
  if (entry.poll) cutEntry.poll = { question: take(entry.poll.question) }
  if (entry.call) cutEntry.call = { description: take(entry.call.description) }
  if (cut) cutEntry.text_cut = true
  return cutEntry
}

/** How a message that alone exceeds a result's budget is cut. */
export const cuttableMessage: Cuttable<MessageEntry> = { size: messageTextLength, cut: cutMessage }
