import { describe, expect, test } from "bun:test"
import { MAX_EMOJI_UNITS, checkedEmoji, isOneEmoji } from "./emoji"
import { ACCEPTED, REFUSED } from "./emoji.testing"

describe("an emoji as a picker offers it", () => {
  test.each(ACCEPTED)("%s is accepted as it is", (_name, emoji) => {
    expect(checkedEmoji(emoji)).toBe(emoji)
    expect(isOneEmoji(emoji)).toBe(true)
  })

  test(`a cluster just inside the ${MAX_EMOJI_UNITS} characters is accepted`, () => {
    const emoji = `\u{1F44D}${"\u200D\u{1F44D}".repeat(19)}`
    expect(emoji.length).toBeLessThanOrEqual(MAX_EMOJI_UNITS)
    expect(checkedEmoji(emoji)).toBe(emoji)
  })
})

describe("anything else", () => {
  test.each(REFUSED)("%s is invalid_argument", (_name, emoji) => {
    expect(isOneEmoji(emoji)).toBe(false)
    expect(() => checkedEmoji(emoji)).toThrow(
      expect.objectContaining({ code: "invalid_argument", message: "emoji must be exactly one emoji, such as 👍." }),
    )
  })
})
