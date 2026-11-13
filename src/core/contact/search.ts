import { z } from "zod"
import { excludedDigest, isExcluded } from "../chat/excluded"
import { chatNumber } from "../chat/jid"
import { chatNameFields } from "../chat/names"
import { ToolError } from "../errors"
import { clampLimit, encodeCursor, fingerprint, fitItems, notACursor, readCursor } from "../pages"
import type { LabelPaths } from "../whatsapp/labels"
import { readContacts, type WacliContact } from "./rows"
import { NAMES_NOTE, SEARCH_LIMIT, type ContactEntry, type ContactReadInput, type ContactReadOutput } from "./schema"

/**
 * Where a page of contacts stopped: the lower-cased name (null for a contact without one) and JID of its last
 * contact, and the account and query it was made under, since a cursor continues one search and no other.
 */
const searchCursor = z.strictObject({ key: z.string().nullable(), id: z.string(), filter: z.string() })

type Position = z.output<typeof searchCursor>

/** The name an entry is ordered by: its name in lower case, or null for none. */
function sortKey(entry: ContactEntry): string | null {
  return entry.name === null ? null : entry.name.toLowerCase()
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** By name, ignoring case, those without a name last, and by JID among equals. */
function comparePositions(a: Pick<Position, "key" | "id">, b: Pick<Position, "key" | "id">): number {
  if (a.key !== b.key) {
    if (a.key === null) return 1
    if (b.key === null) return -1
    return compareText(a.key, b.key)
  }
  return compareText(a.id, b.id)
}

function contactEntry(contact: WacliContact): ContactEntry {
  const entry: ContactEntry = { id: contact.jid, ...chatNameFields(contact.name) }
  const number = chatNumber(contact.jid)
  if (number !== undefined) entry.number = number
  return entry
}

/** One entry for each JID, the one that has a name when several do not agree. */
function distinct(entries: ContactEntry[]): ContactEntry[] {
  const byId = new Map<string, ContactEntry>()
  for (const entry of entries) {
    const known = byId.get(entry.id)
    if (!known || (known.name === null && entry.name !== null)) byId.set(entry.id, entry)
  }
  return [...byId.values()]
}

/** The query, trimmed; a blank or missing one is refused, since wacli reads contacts only by search. */
function readQuery(query: string | undefined): string {
  const trimmed = query?.trim() ?? ""
  if (trimmed === "") {
    throw new ToolError(
      "invalid_argument",
      "query is required for search: part of a name, a phone number or a JID. To browse conversations, use whatsapp_chat_read list.",
    )
  }
  return trimmed
}

/**
 * The `search` method: the contacts of the account's mirror whose name, number or JID holds `query`, by name. wacli
 * cannot page contacts, so the tool reads every match and pages them by a keyset cursor over (name, JID): a contact
 * that appears between pages is not shown twice, and none is skipped. The `excluded` chats are dropped before the
 * contacts sort or page.
 */
export async function searchContacts(
  paths: LabelPaths,
  excluded: ReadonlySet<string>,
  args: ContactReadInput,
  signal: AbortSignal | undefined,
): Promise<ContactReadOutput> {
  const query = readQuery(args.query)
  const limit = clampLimit(args.limit, SEARCH_LIMIT, "limit")
  const filter = fingerprint(paths.label, query, excludedDigest(excluded))
  const after = args.cursor === undefined ? undefined : readCursor(args.cursor, "cursor", searchCursor)
  if (after && after.filter !== filter) throw notACursor("cursor")

  const contacts = (await readContacts(paths, query, signal)).filter((contact) => !isExcluded(excluded, contact.jid))
  const entries = distinct(contacts.map(contactEntry)).sort((a, b) =>
    comparePositions({ key: sortKey(a), id: a.id }, { key: sortKey(b), id: b.id }),
  )
  const remaining = after
    ? entries.filter((entry) => comparePositions({ key: sortKey(entry), id: entry.id }, after) > 0)
    : entries
  const page = remaining.slice(0, limit)

  // The result as it would be sent with `shown` as its contacts, `next` included, so that fitting measures the very
  // JSON that is returned.
  const assemble = (shown: ContactEntry[]): ContactReadOutput => {
    const last = shown[shown.length - 1]
    const more = shown.length < page.length || remaining.length > limit
    return {
      contacts: shown,
      ...(last && more ? { next: encodeCursor({ key: sortKey(last), id: last.id, filter }) } : {}),
      note: NAMES_NOTE,
    }
  }
  const { items } = fitItems(assemble, page, { reserve: 0 })
  return assemble(items)
}
