import { expect, test } from "bun:test"
import { formatLocalTime, localTimeSchema } from "./time"

const INSTANT = Date.parse("2026-11-07T05:03:12.345Z")

test.each([
  [540, "2026-11-07T14:03:12.345+09:00"],
  [-330, "2026-11-06T23:33:12.345-05:30"],
  [0, "2026-11-07T05:03:12.345+00:00"],
])("formats local time at offset %s", (offset, expected) => {
  const result = formatLocalTime(INSTANT, () => offset)
  expect(result).toBe(expected)
  expect(localTimeSchema.parse(result)).toBe(result)
  expect(Date.parse(result)).toBe(INSTANT)
})

test("uses the local offset at the instant by default", () => {
  expect(formatLocalTime(INSTANT)).toBe(formatLocalTime(INSTANT, (ms) => -new Date(ms).getTimezoneOffset()))
})
