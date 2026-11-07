const MINUTES_PER_HOUR = 60

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0")
}

/** The time as the local clock reads it, with its offset, to the millisecond: `2026-11-07T14:03:12.345+09:00`. */
export function localTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? "-" : "+"
  const minutes = Math.abs(offset)
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(minutes / MINUTES_PER_HOUR))}:${pad(minutes % MINUTES_PER_HOUR)}`
  )
}
