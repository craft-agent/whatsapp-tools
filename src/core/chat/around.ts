import { ToolError } from "../errors"
import { fitItems } from "../pages"
import { chatHeader } from "./header"
import { chatKind, parseChatJid } from "./jid"
import { readKinds } from "./kinds"
import { toMessageEntry } from "./message"
import { cuttableMessage } from "./message-cut"
import { DATA_NOTE, type MessageEntry } from "./message-schema"
import type { Mirror } from "./mirror"
import { isUnreadable, type WacliMessage } from "./rows"
import { AROUND_COUNT, type ChatReadInput, type ChatReadOutput } from "./schema"

/** Rows asked for beyond twice a side's count, so that unreadable rows can be dropped and the count still be met. */
const SPARE_ROWS = 20

/** The most rows one side of the context asks wacli for. */
const MAX_ASKED_ROWS = 200

/** A count argument: its default when absent, the most when above it, `invalid_argument` below 0. */
function countArgument(count: number | undefined, name: string): number {
  if (count === undefined) return AROUND_COUNT.default
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ToolError(
      "invalid_argument",
      `${name} must be a whole number from 0 to ${AROUND_COUNT.max}; 0 asks for none.`,
    )
  }
  return Math.min(count, AROUND_COUNT.max)
}

/** How many rows to ask wacli for on a side that is to give `count` readable messages. */
function rowsToAsk(count: number): number {
  return count === 0 ? 0 : Math.min(2 * count + SPARE_ROWS, MAX_ASKED_ROWS)
}

/** The first `count` readable rows of `rows`, which run away from the anchor, and the unreadable rows passed on the way. */
function nearest(rows: readonly WacliMessage[], count: number): { kept: WacliMessage[]; unreadable: number } {
  const kept: WacliMessage[] = []
  let unreadable = 0
  for (const row of rows) {
    if (kept.length >= count) break
    if (isUnreadable(row)) unreadable += 1
    else kept.push(row)
  }
  return { kept, unreadable }
}

/**
 * The `around` method: the message `id` of a chat with the `before_count` messages before it and the `after_count`
 * after it, oldest first. Rows wacli keeps for traffic it could not read are dropped and counted in
 * `unreadable_rows`, and the nearest readable messages are kept; an `id` that names such a row is `not_found`, since
 * there is no message to read around. When the messages do not fit in a result the anchor stays and the messages
 * farthest from it go, alternately from the two sides, counted in `trimmed_before` and `trimmed_after`. There is no
 * cursor: ask again around the message at the edge to read further.
 */
export async function aroundMessage(mirror: Mirror, args: ChatReadInput): Promise<ChatReadOutput> {
  const requested = parseChatJid(args.chat, "chat", "around")
  const id = args.id
  if (id === undefined || id === "") {
    throw new ToolError("invalid_argument", "id is required for around: the id of a message, as a result gives it.")
  }
  const beforeCount = countArgument(args.before_count, "before_count")
  const afterCount = countArgument(args.after_count, "after_count")

  const chat = await mirror.chat(requested)
  const rows = await mirror.context(requested, id, rowsToAsk(beforeCount), rowsToAsk(afterCount))
  const index = rows.findIndex((row) => row.MsgID === id)
  const anchor = rows[index]
  if (!anchor) throw new ToolError("upstream_error", "wacli returned a context without the message asked for.")
  if (isUnreadable(anchor)) {
    throw new ToolError(
      "not_found",
      "No message with this id in this chat: that row holds nothing wacli could read, so it is not a message.",
    )
  }
  const older = nearest(rows.slice(0, index).reverse(), beforeCount)
  const newer = nearest(rows.slice(index + 1), afterCount)

  const context = { id: chat.jid, kind: chatKind(chat.kind) }
  const kinds = await readKinds(mirror, requested, [anchor, ...older.kept, ...newer.kept])
  const anchorEntry = toMessageEntry(anchor, context, kinds)
  const olderEntries = older.kept.map((row) => toMessageEntry(row, context, kinds))
  const newerEntries = newer.kept.map((row) => toMessageEntry(row, context, kinds))

  // Candidates by distance from the anchor, one side then the other, so that trimming takes both ends evenly.
  const candidates: MessageEntry[] = [anchorEntry]
  for (let distance = 0; distance < Math.max(olderEntries.length, newerEntries.length); distance += 1) {
    const [before, after] = [olderEntries[distance], newerEntries[distance]]
    if (before) candidates.push(before)
    if (after) candidates.push(after)
  }
  // Where each message sits relative to the anchor: negative before it, positive after it. An entry may come back
  // cut, so it is looked up by id.
  const place = new Map<string, number>([
    ...olderEntries.map((entry, distance): [string, number] => [entry.id, -(distance + 1)]),
    [anchorEntry.id, 0],
    ...newerEntries.map((entry, distance): [string, number] => [entry.id, distance + 1]),
  ])
  const unreadable = older.unreadable + newer.unreadable
  // The result as it would be sent with `shown` as its messages, the counts of what was left out included, so that
  // fitting measures the very JSON that is returned.
  const assemble = (shown: MessageEntry[]): ChatReadOutput => {
    let shownBefore = 0
    let shownAfter = 0
    for (const entry of shown) {
      const offset = place.get(entry.id)!
      if (offset < 0) shownBefore += 1
      else if (offset > 0) shownAfter += 1
    }
    return {
      chat: chatHeader(chat.jid, context.kind, chat.name),
      anchor: anchorEntry.id,
      messages: [...shown].sort((a, b) => place.get(a.id)! - place.get(b.id)!),
      ...(unreadable > 0 ? { unreadable_rows: unreadable } : {}),
      ...(shownBefore < olderEntries.length ? { trimmed_before: olderEntries.length - shownBefore } : {}),
      ...(shownAfter < newerEntries.length ? { trimmed_after: newerEntries.length - shownAfter } : {}),
      note: DATA_NOTE,
    }
  }
  const { items } = fitItems(assemble, candidates, { cuttable: cuttableMessage, reserve: 0 })
  return assemble(items)
}
