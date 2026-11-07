import { formatLocalTime } from "../core/time"

/** The time as the local clock reads it, with its offset, to the millisecond: `2026-11-07T14:03:12.345+09:00`. */
export function localTimestamp(date: Date): string {
  return formatLocalTime(date.getTime())
}
