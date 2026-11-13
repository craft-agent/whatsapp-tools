import { createHash } from "node:crypto"
import { MS_PER_SECOND } from "../time"
import { isExcluded } from "./excluded"
import type { Mirror } from "./mirror"
import { isUnreadable, messageSecond, type WacliMessage } from "./rows"

/** The most rows one call looks through, counting the unreadable ones, so a chat of protocol traffic ends a page. */
export const SCAN_LIMIT = 2000

/** The most rows one read of wacli asks for. */
const MAX_CHUNK = 1000

/** How many bytes of an id's SHA-256 a cursor keeps: 8 are 11 characters, and a clash within one second is out of reach. */
const DIGEST_BYTES = 8

/** A short stand-in for a message id, so that a cursor over hundreds of messages of one second stays small. */
export function idDigest(id: string): string {
  return createHash("sha256").update(id).digest().subarray(0, DIGEST_BYTES).toString("base64url")
}

/**
 * Where a scan, newest first, has got to: the second its last row was sent in and the digests (`idDigest`) of the
 * ids of every row of that second already taken, whether kept or dropped. Everything newer is behind it. wacli's
 * own cursor would expire with the next message the sync stores, so a page ends at a second and the ids taken in
 * it instead.
 */
export type Position = { second: number; ids: string[] }

/**
 * A row a scan took, in the order it took them, by the digest of its id. A row of an excluded chat is neither
 * readable nor unreadable: it moves the position past it like any row, is never shown and is never counted.
 */
export type Taken = { id: string; second: number; readable: boolean; excluded: boolean }

/** What a scan found. */
export type Scan = {
  /** The readable rows taken, newest first: at most the limit. */
  rows: WacliMessage[]
  /** Every row taken, readable or not, in the same order. */
  taken: Taken[]
  /** Whether rows may remain after the last one taken: a further readable row, or the scan limit. */
  more: boolean
}

/** Which rows to scan. */
export type ScanRequest = {
  chat: string
  /** How many readable rows to take. */
  limit: number
  /** Exclusive bounds in whole seconds; `before` applies only to a scan that does not continue one. */
  afterSecond?: number
  beforeSecond?: number
  /** Where the page before ended. */
  from?: Position
}

/** The position after `taken` rows, which continue a scan that stood at `from`. */
export function positionAfter(from: Position | undefined, taken: readonly Taken[]): Position | undefined {
  let position = from && { second: from.second, ids: [...from.ids] }
  for (const row of taken) {
    if (position?.second === row.second) position.ids.push(row.id)
    else position = { second: row.second, ids: [row.id] }
  }
  return position
}

/** Whole seconds bounded strictly after `ms`: rounded down, so that `> second` matches every instant after `ms`. */
export function secondAfter(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.floor(ms / MS_PER_SECOND)
}

/** Whole seconds bounded strictly before `ms`: rounded up, so that `< second` matches every instant before `ms`. */
export function secondBefore(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.ceil(ms / MS_PER_SECOND)
}

/** The rows taken up to and including the `kept`-th readable one: what a page that stopped there consumed. */
export function takenThrough(taken: readonly Taken[], kept: number): Taken[] {
  let readable = 0
  for (const [index, row] of taken.entries()) {
    if (row.readable) readable += 1
    if (readable === kept) return taken.slice(0, index + 1)
  }
  return [...taken]
}

/**
 * What a page that showed `shown` of `total` readable rows consumed from `all`: the rows taken, the unreadable
 * count, and the position reached.
 */
export function pageProgress(
  all: readonly Taken[],
  shown: number,
  total: number,
  from: Position | undefined,
): { stopped: boolean; unreadable: number; position: Position | undefined } {
  const stopped = shown < total
  const taken = stopped ? takenThrough(all, shown) : all
  const unreadable = taken.filter((row) => !row.readable && !row.excluded).length
  const position = positionAfter(from, taken)
  return { stopped, unreadable, position }
}

/**
 * Takes up to `limit` readable messages, newest first, from where `from` stands, with the unreadable rows between
 * them. It reads wacli in growing chunks, each from the second the last one ended at (`before` that second + 1)
 * and skipping the ids already taken at it. It stops without taking the readable row after the last one it keeps,
 * so that `more` is exact, and does not stop earlier at unreadable rows. A row that wacli files under an `excluded`
 * chat (another JID of the person asked for) is taken like an unreadable one, so the position moves past it, but is
 * never kept or counted as unreadable.
 */
export async function scanMessages(mirror: Mirror, excluded: ReadonlySet<string>, request: ScanRequest): Promise<Scan> {
  const { chat, limit, afterSecond } = request
  const rows: WacliMessage[] = []
  const taken: Taken[] = []
  let position = request.from && { second: request.from.second, ids: new Set(request.from.ids) }
  for (let round = 0; ; round += 1) {
    const wanted = limit - rows.length + (position?.ids.size ?? 0) + 1
    const size = Math.min(wanted * 2 ** round, MAX_CHUNK + (position?.ids.size ?? 0))
    const chunk = await mirror.messages({
      chat,
      limit: size,
      afterSecond,
      beforeSecond: position ? position.second + 1 : request.beforeSecond,
    })
    for (const row of chunk) {
      const second = messageSecond(row)
      const id = idDigest(row.MsgID)
      if (position?.second === second && position.ids.has(id)) continue
      const hidden = isExcluded(excluded, row.ChatJID)
      const readable = !hidden && !isUnreadable(row)
      if (taken.length >= SCAN_LIMIT || (readable && rows.length >= limit)) return { rows, taken, more: true }
      if (readable) rows.push(row)
      taken.push({ id, second, readable, excluded: hidden })
      if (position?.second === second) position.ids.add(id)
      else position = { second, ids: new Set([id]) }
    }
    if (chunk.length < size) return { rows, taken, more: false }
  }
}
