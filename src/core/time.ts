import { z } from "zod"
import { ToolError } from "./errors"

/** Milliseconds in a second, the unit wacli stores message times in. */
export const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 60

/** How far a zone is east of UTC, in minutes, at an instant (milliseconds since the epoch). */
export type OffsetMinutes = (ms: number) => number

/** The offset of the process's own time zone. */
export const localOffsetMinutes: OffsetMinutes = (ms) => -new Date(ms).getTimezoneOffset()

/** A time as a result writes it: local time with its offset, to the millisecond. */
export const localTimeSchema = z.iso.datetime({ offset: true })

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/** `ms` as local time with its offset, to the millisecond: `2026-11-07T14:03:12.345+09:00`. UTC reads `+00:00`, never `Z`. */
export function formatLocalTime(ms: number, offsetMinutes: OffsetMinutes = localOffsetMinutes): string {
  const offset = Math.round(offsetMinutes(ms))
  const wall = new Date(ms + offset * MS_PER_MINUTE).toISOString().slice(0, -1)
  const magnitude = Math.abs(offset)
  const sign = offset < 0 ? "-" : "+"
  return `${wall}${sign}${pad(Math.trunc(magnitude / MINUTES_PER_HOUR))}:${pad(magnitude % MINUTES_PER_HOUR)}`
}

/** Date, then optionally a time of day (seconds and fraction optional) and an offset (`Z` or `±hh:mm`). */
const TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:([Zz])|([+-])(\d{2}):(\d{2}))?)?$/

const MILLISECOND_DIGITS = 3
/** `Date` reads the years 0 to 99 as 1900 to 1999, so an argument names a year from 1000 on. */
const MIN_YEAR = 1000
const MAX_HOUR = 23
const MAX_MINUTE = 59

function badTime(text: string, name: string): ToolError {
  return new ToolError(
    "invalid_argument",
    `${name} is not a time: ${JSON.stringify(text)}. Use RFC 3339 with an offset (2026-11-07T14:03:12+09:00), or a date or time without one (2026-11-07, 2026-11-07T14:03), which reads as local time.`,
  )
}

/** Whether the calendar has this day (`2026-02-30` and month 13 do not exist). */
function isCalendarDay(year: number, month: number, day: number): boolean {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * Milliseconds since the epoch for a time argument: RFC 3339 with an offset
 * (`2026-11-07T14:03:12.345+09:00`, `…Z`), or a date or time without one
 * (`2026-11-07`, `2026-11-07T14:03`), which is local time, built the way
 * JavaScript's `Date` builds it: a local time a clock change skips or repeats
 * reads as `Date` reads it. Anything else, an impossible date included, is
 * `invalid_argument` naming the argument and the accepted forms.
 */
export function parseTimeArgument(text: string, name: string): number {
  const match = TIME_PATTERN.exec(text.trim())
  if (!match) throw badTime(text, name)
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "", zulu, sign, offsetHour, offsetMin] =
    match
  const [y, mon, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const ms = Number(fraction.padEnd(MILLISECOND_DIGITS, "0").slice(0, MILLISECOND_DIGITS))
  if (y < MIN_YEAR || !isCalendarDay(y, mon, d) || h > MAX_HOUR || mi > MAX_MINUTE || s > MAX_MINUTE) {
    throw badTime(text, name)
  }
  if (sign === undefined && zulu === undefined) return new Date(y, mon - 1, d, h, mi, s, ms).getTime()
  const wall = Date.UTC(y, mon - 1, d, h, mi, s, ms)
  if (zulu) return wall
  const offsetH = Number(offsetHour)
  const offsetM = Number(offsetMin)
  if (offsetH > MAX_HOUR || offsetM > MAX_MINUTE) throw badTime(text, name)
  const offset = (offsetH * MINUTES_PER_HOUR + offsetM) * MS_PER_MINUTE
  return sign === "-" ? wall + offset : wall - offset
}
