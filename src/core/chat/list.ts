import { z } from "zod"
import { clampLimit, encodeCursor, fingerprint, fitItems, notACursor, readCursor, type Cuttable } from "../pages"
import { MS_PER_SECOND, formatLocalTime } from "../time"
import { mapConcurrently } from "./concurrent"
import { chatKind, chatNumber } from "./jid"
import { readKinds } from "./kinds"
import { toMessageEntry } from "./message"
import { cutMessage, messageTextLength } from "./message-cut"
import { DATA_NOTE, type MessageEntry } from "./message-schema"
import type { Mirror } from "./mirror"
import { chatNameFields } from "./names"
import { isUnreadable, type WacliChat } from "./rows"
import { LAST_MESSAGE_ROWS, LIMITS, type ChatEntry, type ChatReadInput, type ChatReadOutput } from "./schema"

/** How many chats have their last message read at once. */
const LAST_MESSAGE_CONCURRENCY = 4

/** wacli's `muted_until` for a chat muted for good. */
const MUTED_FOREVER = -1

/**
 * Where a page of chats stops: the activity second (0 for a chat with none) and JID of its last chat, and the
 * arguments and account it was made under, since a cursor continues one list and no other.
 */
const listCursor = z.strictObject({ second: z.number().int(), jid: z.string(), filter: z.string() })

/** A chat's last message that alone exceeds a result's budget is cut like any message. */
const cuttableChat: Cuttable<ChatEntry> = {
  size: (chat) => (chat.last_message ? messageTextLength(chat.last_message) : 0),
  cut: (chat, keep) => (chat.last_message ? { ...chat, last_message: cutMessage(chat.last_message, keep) } : chat),
}

/** The second of the chat's last activity, or 0 when wacli has none (it writes the zero time then). */
function activity(chat: WacliChat): number {
  const ms = Date.parse(chat.last_message_ts)
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / MS_PER_SECOND) : 0
}

/** Newest activity first, and by JID among equals; wacli's own order (pinned first) is not the list's. */
function byActivity(a: WacliChat, b: WacliChat): number {
  return activity(b) - activity(a) || (a.jid < b.jid ? -1 : a.jid > b.jid ? 1 : 0)
}

function isMuted(chat: WacliChat, nowSecond: number): boolean {
  return chat.muted_until === MUTED_FOREVER || (chat.muted_until > 0 && chat.muted_until > nowSecond)
}

function chatEntry(chat: WacliChat, nowSecond: number): ChatEntry {
  const seconds = activity(chat)
  const unread = Math.max(0, chat.unread_count)
  const entry: ChatEntry = {
    id: chat.jid,
    kind: chatKind(chat.kind),
    ...chatNameFields(chat.name),
    unread,
    last_activity_at: seconds > 0 ? formatLocalTime(seconds * MS_PER_SECOND) : null,
  }
  const number = chatNumber(chat.jid)
  if (number !== undefined) entry.number = number
  if (chat.unread && unread === 0) entry.marked_unread = true
  if (chat.archived) entry.archived = true
  if (chat.pinned) entry.pinned = true
  if (isMuted(chat, nowSecond)) entry.muted = true
  return entry
}

/** The newest row of the chat that is not an unreadable one, among its latest rows, or null. */
async function lastMessage(mirror: Mirror, chat: WacliChat): Promise<MessageEntry | null> {
  const rows = await mirror.messages({ chat: chat.jid, limit: LAST_MESSAGE_ROWS })
  const row = rows.find((candidate) => !isUnreadable(candidate))
  if (!row) return null
  const kinds = await readKinds(mirror, chat.jid, [row])
  return toMessageEntry(row, { id: chat.jid, kind: chatKind(chat.kind) }, kinds)
}

/**
 * The `list` method: chats newest activity first, optionally those whose name or JID holds `query`, or that are
 * unread, each with its last real message on request. wacli cannot page chats, so the tool reads them all and pages
 * them by a keyset cursor over (activity, JID): a chat that gains a message between pages is not shown twice.
 */
export async function listChats(mirror: Mirror, args: ChatReadInput, now: number): Promise<ChatReadOutput> {
  const limit = clampLimit(args.limit, LIMITS.list, "limit")
  const query = args.query?.trim() ?? ""
  const unread = args.unread === true
  const filter = fingerprint(mirror.label, query, unread, args.last === true)
  const after = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", listCursor)
  if (after && after.filter !== filter) throw notACursor("cursor")

  const chats = (await mirror.chats({ query, unread })).sort(byActivity)
  const remaining = after
    ? chats.filter((chat) => activity(chat) < after.second || (activity(chat) === after.second && chat.jid > after.jid))
    : chats
  const page = remaining.slice(0, limit)
  const nowSecond = Math.floor(now / MS_PER_SECOND)
  const entries = page.map((chat) => chatEntry(chat, nowSecond))
  if (args.last) {
    const last = await mapConcurrently(page, LAST_MESSAGE_CONCURRENCY, (chat) => lastMessage(mirror, chat))
    entries.forEach((entry, index) => (entry.last_message = last[index]))
  }

  // The result as it would be sent with `shown` as its chats, `next` included, so that fitting measures the very JSON
  // that is returned.
  const assemble = (shown: ChatEntry[]): ChatReadOutput => {
    const lastShown = page[shown.length - 1]
    const more = shown.length < entries.length || remaining.length > limit
    return {
      chats: shown,
      ...(lastShown && more ? { next: encodeCursor({ second: activity(lastShown), jid: lastShown.jid, filter }) } : {}),
      note: DATA_NOTE,
    }
  }
  const { items } = fitItems(assemble, entries, { cuttable: cuttableChat, reserve: 0 })
  return assemble(items)
}
