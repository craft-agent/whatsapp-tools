import { z } from "zod"
import { ToolError } from "../errors"
import { clampLimit, encodeCursor, fingerprint, fitItems, notACursor, readCursor } from "../pages"
import { parseTimeArgument } from "../time"
import { mapConcurrently } from "./concurrent"
import { chatHeader } from "./header"
import { chatKind, parseChatJid } from "./jid"
import { readKinds } from "./kinds"
import { toMessageEntry } from "./message"
import { cuttableMessage } from "./message-cut"
import { DATA_NOTE, type MessageEntry } from "./message-schema"
import type { Mirror, SearchHits } from "./mirror"
import { isUnreadable, messageSecond, type WacliChat, type WacliHit } from "./rows"
import { idDigest, pageProgress, secondAfter, secondBefore, type Position, type Taken } from "./scan"
import { LIMITS, type ChatReadInput, type ChatReadOutput } from "./schema"

/** The most hits one call asks wacli for, so that a window with more than this may lack hits (see `incomplete`). */
export const SEARCH_FETCH_CAP = 1000

/** How many chats have their polls and calls looked up at once. */
const CHAT_CONCURRENCY = 4

/**
 * Where a page of hits stops, bound to the account and the search it was made under: the second its last hit was
 * sent in, and the digests of the ids already taken at that second.
 */
const searchCursor = z.strictObject({ second: z.number().int(), ids: z.array(z.string()), filter: z.string() })

/** The hits a page takes: the readable ones kept, every one taken, and whether hits remain after them. */
type Taking = { rows: WacliHit[]; taken: Taken[]; more: boolean }

/** What names a hit across chats: a message id is only one within its chat. */
function hitKey(hit: WacliHit): string {
  return `${hit.ChatJID}\n${hit.MsgID}`
}

/** Newest first, and by chat and id among the hits of one second, so that the order does not depend on wacli's ranking. */
function newestFirst(a: WacliHit, b: WacliHit): number {
  const [keyA, keyB] = [hitKey(a), hitKey(b)]
  return messageSecond(b) - messageSecond(a) || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0)
}

/**
 * Takes up to `limit` readable hits, newest first, from where `from` stands: the ids already taken at its second
 * are skipped. It stops without taking the readable hit after the last one it keeps, so that `more` is exact; when
 * it runs through every hit wacli returned, `more` is whether wacli held more than it returned.
 */
function takeHits(found: SearchHits, from: Position | undefined, limit: number): Taking {
  const done = new Set(from?.ids)
  const rows: WacliHit[] = []
  const taken: Taken[] = []
  for (const hit of [...found.hits].sort(newestFirst)) {
    const second = messageSecond(hit)
    const id = idDigest(hitKey(hit))
    if (from?.second === second && done.has(id)) continue
    const readable = !isUnreadable(hit)
    if (readable && rows.length >= limit) return { rows, taken, more: true }
    if (readable) rows.push(hit)
    taken.push({ id, second, readable })
  }
  return { rows, taken, more: found.more }
}

/** The chats the hits are in, as the mirror holds them: those in `known`, and the rest from one read of every chat. */
async function chatsOf(
  mirror: Mirror,
  jids: readonly string[],
  known: ReadonlyMap<string, WacliChat>,
): Promise<Map<string, WacliChat>> {
  const chats = new Map(known)
  if (jids.some((jid) => !chats.has(jid))) {
    for (const chat of await mirror.chats({})) chats.set(chat.jid, chat)
  }
  return chats
}

/**
 * The `search` method: the messages whose text, caption, file name, or sender or chat name holds `query`, in one
 * chat or all, between `after` and `before` (both exclusive), newest first, each with its chat. wacli may rank hits
 * by relevance and caps what it returns, so each call asks it for the window's hits, sorts them by time and pages
 * them by the tool's own position (second and id digests, as `view` does), never wacli's cursor. When wacli ranked
 * the hits and held more than the cap, newer hits may be missing from the window and the result is `incomplete`.
 */
export async function searchMessages(mirror: Mirror, args: ChatReadInput): Promise<ChatReadOutput> {
  const text = args.query?.trim() ?? ""
  if (text === "") {
    throw new ToolError("invalid_argument", "query is required for search: the text to find in messages.")
  }
  const requested = args.chat === undefined ? undefined : parseChatJid(args.chat, "chat", "search")
  const limit = clampLimit(args.limit, LIMITS.search, "limit")
  const after = args.after === undefined ? undefined : parseTimeArgument(args.after, "after")
  const before = args.before === undefined ? undefined : parseTimeArgument(args.before, "before")
  const filter = fingerprint(mirror.label, text, requested ?? null, after ?? null, before ?? null)
  const cursor = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", searchCursor)
  if (cursor && cursor.filter !== filter) throw notACursor("cursor")

  const from = cursor && { second: cursor.second, ids: cursor.ids }
  const known = new Map<string, WacliChat>()
  if (requested) known.set(requested, await mirror.chat(requested))
  const found = await mirror.search({
    text,
    chat: requested,
    // The ids already taken at the boundary second are dropped from what wacli returns, so they are asked for on top.
    limit: SEARCH_FETCH_CAP + (from?.ids.length ?? 0),
    afterSecond: secondAfter(after),
    beforeSecond: from ? from.second + 1 : secondBefore(before),
  })
  const scan = takeHits(found, from, limit)

  const jids = [...new Set(scan.rows.map((row) => row.ChatJID))]
  const chats = await chatsOf(mirror, jids, known)
  const kinds = new Map(
    await mapConcurrently(jids, CHAT_CONCURRENCY, async (jid) => {
      const rows = scan.rows.filter((row) => row.ChatJID === jid)
      return [jid, await readKinds(mirror, jid, rows)] as const
    }),
  )
  const entries = scan.rows.map((row) => {
    const chat = chats.get(row.ChatJID)
    const kind = chatKind(chat?.kind ?? "")
    const entry = toMessageEntry(row, { id: row.ChatJID, kind }, kinds.get(row.ChatJID)!)
    entry.chat = chatHeader(row.ChatJID, kind, chat?.name ?? row.ChatName)
    return entry
  })

  // The result as it would be sent with `shown` as its hits, `next` included, so that fitting measures the very JSON
  // that is returned. A page that shows fewer hits than were read consumed only the rows up to its last hit; the
  // rest are read again, and counted again, by the page that continues it.
  const assemble = (shown: MessageEntry[]): ChatReadOutput => {
    const { stopped, unreadable, position } = pageProgress(scan.taken, shown.length, entries.length, from)
    return {
      messages: shown,
      ...(unreadable > 0 ? { unreadable_rows: unreadable } : {}),
      ...(found.ranked && found.more ? { incomplete: true as const } : {}),
      ...(position && (stopped || scan.more) ? { next: encodeCursor({ ...position, filter }) } : {}),
      note: DATA_NOTE,
    }
  }
  const { items } = fitItems(assemble, entries, { cuttable: cuttableMessage, reserve: 0 })
  return assemble(items)
}
