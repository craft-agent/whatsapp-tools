import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type { z } from "zod"
import { ToolError } from "./errors"

/** The most characters of JSON a result takes, kept below the 60,000 that some harnesses refuse, with room to spare. */
export const RESULT_BUDGET = 50_000

/** Room kept in a result for its `next` cursor, which only a page that stopped early carries. */
export const NEXT_RESERVE = 300

/** The default and the largest `limit` of one method. */
export type LimitRule = { default: number; max: number }

/** A `limit` argument: the rule's default when absent, the largest when above it, `invalid_argument` below 1. */
export function clampLimit(limit: number | undefined, rule: LimitRule, name: string): number {
  if (limit === undefined) return rule.default
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ToolError("invalid_argument", `${name} must be a whole number of at least 1; the largest is ${rule.max}.`)
  }
  return Math.min(limit, rule.max)
}

/** An opaque string for a caller to pass back as `cursor`: `value` as base64url JSON. */
export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

/** The error for a cursor that is not one this tool returned for this call: malformed, of another shape, or for another chat or filter. */
export function notACursor(name: string): ToolError {
  return new ToolError("invalid_argument", `${name} is not a cursor this tool returned.`)
}

/** What `encodeCursor` wrapped, or `invalid_argument` when `text` is not a cursor this tool returned. */
export function decodeCursor(text: string, name: string): unknown {
  const bytes = Buffer.from(text, "base64url")
  if (bytes.toString("base64url") !== text) throw notACursor(name)
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    throw notACursor(name)
  }
}

/** `decodeCursor`, then the shape `schema` says; a cursor of another shape is refused the same way. */
export function readCursor<S extends z.ZodType>(text: string, name: string, schema: S): z.output<S> {
  const parsed = schema.safeParse(decodeCursor(text, name))
  if (!parsed.success) throw notACursor(name)
  return parsed.data
}

const FILTER_LENGTH = 16

/**
 * A short stand-in for the arguments a paged call was made under, kept in its
 * cursor so that the cursor continues that call and no other, and so that a
 * long query does not outgrow the room a cursor has.
 */
export function fingerprint(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, FILTER_LENGTH)
}

const HIGH_SURROGATE = /[\uD800-\uDBFF]$/

/** The first `keep` characters of `text`, never ending inside a surrogate pair. */
export function cutText(text: string, keep: number): string {
  return text.length <= keep ? text : text.slice(0, keep).replace(HIGH_SURROGATE, "")
}

/** How to cut a single item that alone exceeds the budget. */
export type Cuttable<T> = {
  /** How many characters of text the item can lose. */
  size(item: T): number
  /** The item keeping only `keep` of those characters, marked as cut. */
  cut(item: T, keep: number): T
  /** The item without its next piece of metadata and marked as cut, or null when none is left to drop. */
  drop?(item: T): T | null
}

export type FitOptions<T> = {
  /** Room to keep for a `next` that `assemble` does not build, which a caller that builds it sets to 0; defaults to `NEXT_RESERVE`. */
  reserve?: number
  /** Cuts the first item when it alone exceeds the budget. */
  cuttable?: Cuttable<T>
}

export type Fitted<T> = {
  /** The leading candidates that fit, at least one when there are any. */
  items: T[]
  /** Whether candidates were left out, so the result needs a `next`. */
  stopped: boolean
}

function jsonLength(value: unknown): number {
  return JSON.stringify(value).length
}

/** The item with the most text kept that still makes the result at most `room` long; `cut` must fit with none kept. */
function mostText<T>(item: T, room: number, cuttable: Cuttable<T>, measure: (item: T) => number): T {
  let low = 0
  let high = cuttable.size(item)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(cuttable.cut(item, middle)) <= room) low = middle
    else high = middle - 1
  }
  return cuttable.cut(item, low)
}

/**
 * The item cut so that the result holding it is at most `room` characters of JSON (`measure` gives that length):
 * its text cut as little as possible, and when even none fits, its metadata dropped one piece at a time (`drop`)
 * until it does. An item that cannot get under `room` comes back with everything dropped and no text.
 */
function cutToFit<T>(item: T, room: number, cuttable: Cuttable<T>, measure: (item: T) => number): T {
  let current = item
  for (;;) {
    if (measure(cuttable.cut(current, 0)) <= room) return mostText(current, room, cuttable, measure)
    const next = cuttable.drop?.(current)
    if (!next) return cuttable.cut(current, 0)
    current = next
  }
}

/**
 * Takes candidates in order while the result stays within `RESULT_BUDGET`
 * (less `options.reserve` for a `next` that `assemble` does not build).
 * `assemble` builds the whole result from the items taken, `next` included
 * when the caller can know it, and every step measures that result, so the
 * size checked is the size sent. A first candidate that alone exceeds the
 * budget is cut with `options.cuttable`, or taken whole without one: a call
 * always returns at least one item.
 */
export function fitItems<T>(
  assemble: (items: T[]) => object,
  candidates: readonly T[],
  options: FitOptions<T> = {},
): Fitted<T> {
  // The budget is a length to stay under, so the longest result is one character short of it.
  const room = RESULT_BUDGET - 1 - (options.reserve ?? NEXT_RESERVE)
  const items: T[] = []
  for (const candidate of candidates) {
    items.push(candidate)
    if (jsonLength(assemble(items)) <= room) continue
    items.pop()
    if (items.length > 0) return { items, stopped: true }
    const { cuttable } = options
    const only = cuttable ? cutToFit(candidate, room, cuttable, (item) => jsonLength(assemble([item]))) : candidate
    return { items: [only], stopped: candidates.length > 1 }
  }
  return { items, stopped: false }
}
