import { describe, expect, test } from "bun:test"
import { localTimestamp } from "./local-time"

describe("localTimestamp", () => {
  test("reads the local clock to the millisecond, with the offset that keeps the instant exact", () => {
    for (const date of [new Date(2026, 10, 7, 14, 3, 12, 345), new Date(2026, 6, 1, 0, 0, 0, 5), new Date(0)]) {
      const text = localTimestamp(date)
      expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
      expect(new Date(text).getTime()).toBe(date.getTime())
    }
  })

  test("pads every field", () => {
    expect(localTimestamp(new Date(2026, 0, 2, 3, 4, 5, 6)).slice(0, 23)).toBe("2026-01-02T03:04:05.006")
  })
})
