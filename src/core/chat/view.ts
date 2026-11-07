import { z } from "zod"
import { clampLimit, encodeCursor, fingerprint, fitItems, notACursor, readCursor } from "../pages"
import { MS_PER_SECOND, parseTimeArgument } from "../time"
import { chatKind, chatNumber, parseChatJid, type ChatKind } from "./jid"
import { readKinds } from "./kinds"
import { toMessageEntry } from "./message"
import { cuttableMessage } from "./message-cut"
import { DATA_NOTE, type ChatRef, type MessageEntry } from "./message-schema"
import type { Mirror } from "./mirror"
import { chatNameFields } from "./names"
import { LIMITS, type ChatReadInput, type ChatReadOutput } from "./schema"
import { positionAfter, scanMessages, type Taken } from "./scan"

/**
 * Where a page of messages stops, bound to the account, the chat and the bounds it was made under: the second its
 * last row was sent in, and the digests of the ids already taken at that second.
 */
const viewCursor = z.strictObject({
  chat: z.string(),
  second: z.number().int(),
  ids: z.array(z.string()),
  filter: z.string(),
})

/** The chat header of a result. */
function header(jid: string, kind: ChatKind, name: string): ChatRef {
  const ref: ChatRef = { id: jid, kind, ...chatNameFields(name) }
  const number = chatNumber(jid)
  if (number !== undefined) ref.number = number
  return ref
}

/** The rows taken up to and including the `kept`-th readable one: what a page that stopped there consumed. */
function takenThrough(taken: readonly Taken[], kept: number): Taken[] {
  let readable = 0
  for (const [index, row] of taken.entries()) {
    if (row.readable) readable += 1
    if (readable === kept) return taken.slice(0, index + 1)
  }
  return [...taken]
}

/**
 * The `view` method: the newest messages of one chat between `after` and `before` (both exclusive), oldest first.
 * `next` continues with older ones from the second the page ended at, with the ids already taken in it, so the
 * messages that arrive in between move no page. A row wacli keeps for traffic it could not read is dropped and
 * counted in `unreadable_rows`, once, in the page that passed it.
 */
export async function viewChat(mirror: Mirror, args: ChatReadInput): Promise<ChatReadOutput> {
  const requested = parseChatJid(args.chat, "chat", "view")
  const limit = clampLimit(args.limit, LIMITS.view, "limit")
  const after = args.after === undefined ? undefined : parseTimeArgument(args.after, "after")
  const before = args.before === undefined ? undefined : parseTimeArgument(args.before, "before")
  const filter = fingerprint(mirror.label, after ?? null, before ?? null)
  const cursor = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", viewCursor)
  if (cursor && (cursor.chat !== requested || cursor.filter !== filter)) throw notACursor("cursor")

  const from = cursor && { second: cursor.second, ids: cursor.ids }
  const chat = await mirror.chat(requested)
  const context = { id: chat.jid, kind: chatKind(chat.kind) }
  const scan = await scanMessages(mirror, {
    chat: requested,
    limit,
    // wacli bounds whole seconds exclusively and stores whole seconds, so rounding `after` down and `before` up
    // keeps exactly the messages whose time lies strictly between the two instants.
    afterSecond: after === undefined ? undefined : Math.floor(after / MS_PER_SECOND),
    beforeSecond: before === undefined ? undefined : Math.ceil(before / MS_PER_SECOND),
    from,
  })

  const kinds = await readKinds(mirror, requested, scan.rows)
  const entries = scan.rows.map((row) => toMessageEntry(row, context, kinds))
  // The result as it would be sent with `shown` as its messages, `next` included, so that fitting measures the
  // very JSON that is returned. A page that shows fewer messages than were read consumed only the rows up to its
  // last message; the rest are read again, and counted again, by the page that continues it.
  const assemble = (shown: MessageEntry[]): ChatReadOutput => {
    const stopped = shown.length < entries.length
    const taken = stopped ? takenThrough(scan.taken, shown.length) : scan.taken
    const unreadable = taken.filter((row) => !row.readable).length
    const position = positionAfter(from, taken)
    return {
      chat: header(chat.jid, context.kind, chat.name),
      messages: [...shown].reverse(),
      ...(unreadable > 0 ? { unreadable_rows: unreadable } : {}),
      ...(position && (stopped || scan.more) ? { next: encodeCursor({ chat: requested, ...position, filter }) } : {}),
      note: DATA_NOTE,
    }
  }
  const { items } = fitItems(assemble, entries, { cuttable: cuttableMessage, reserve: 0 })
  return assemble(items)
}
