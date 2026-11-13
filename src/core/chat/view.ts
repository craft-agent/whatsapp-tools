import { z } from "zod"
import { clampLimit, encodeCursor, fingerprint, fitItems, notACursor, readCursor } from "../pages"
import { parseTimeArgument } from "../time"
import { excludedDigest } from "./excluded"
import { chatHeader } from "./header"
import { chatKind, parseChatJid } from "./jid"
import { readKinds } from "./kinds"
import { toMessageEntry } from "./message"
import { cuttableMessage } from "./message-cut"
import { DATA_NOTE, type MessageEntry } from "./message-schema"
import type { Mirror } from "./mirror"
import { LIMITS, type ChatReadInput, type ChatReadOutput } from "./schema"
import { pageProgress, scanMessages, secondAfter, secondBefore } from "./scan"

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

/**
 * The `view` method: the newest messages of one chat between `after` and `before` (both exclusive), oldest first.
 * `next` continues with older ones from the second the page ended at, with the ids already taken in it, so the
 * messages that arrive in between move no page. A row wacli keeps for traffic it could not read is dropped and
 * counted in `unreadable_rows`, once, in the page that passed it. A row wacli files under an `excluded` JID of the
 * same person is passed over like one, but neither shown nor counted.
 */
export async function viewChat(
  mirror: Mirror,
  excluded: ReadonlySet<string>,
  args: ChatReadInput,
): Promise<ChatReadOutput> {
  const requested = parseChatJid(args.chat, "chat", "view")
  const limit = clampLimit(args.limit, LIMITS.view, "limit")
  const after = args.after === undefined ? undefined : parseTimeArgument(args.after, "after")
  const before = args.before === undefined ? undefined : parseTimeArgument(args.before, "before")
  const filter = fingerprint(mirror.label, after ?? null, before ?? null, excludedDigest(excluded))
  const cursor = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", viewCursor)
  if (cursor && (cursor.chat !== requested || cursor.filter !== filter)) throw notACursor("cursor")

  const from = cursor && { second: cursor.second, ids: cursor.ids }
  const chat = await mirror.chat(requested)
  const context = { id: chat.jid, kind: chatKind(chat.kind, chat.jid) }
  const scan = await scanMessages(mirror, excluded, {
    chat: requested,
    limit,
    afterSecond: secondAfter(after),
    beforeSecond: secondBefore(before),
    from,
  })

  const kinds = await readKinds(mirror, excluded, requested, scan.rows)
  const entries = scan.rows.map((row) => toMessageEntry(row, context, kinds))
  // The result as it would be sent with `shown` as its messages, `next` included, so that fitting measures the
  // very JSON that is returned. A page that shows fewer messages than were read consumed only the rows up to its
  // last message; the rest are read again, and counted again, by the page that continues it.
  const assemble = (shown: MessageEntry[]): ChatReadOutput => {
    const { stopped, unreadable, position } = pageProgress(scan.taken, shown.length, entries.length, from)
    return {
      chat: chatHeader(chat.jid, context.kind, chat.name),
      messages: [...shown].reverse(),
      ...(unreadable > 0 ? { unreadable_rows: unreadable } : {}),
      ...(position && (stopped || scan.more) ? { next: encodeCursor({ chat: requested, ...position, filter }) } : {}),
      note: DATA_NOTE,
    }
  }
  const { items } = fitItems(assemble, entries, { cuttable: cuttableMessage, reserve: 0 })
  return assemble(items)
}
