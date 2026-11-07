import { z } from "zod"

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
