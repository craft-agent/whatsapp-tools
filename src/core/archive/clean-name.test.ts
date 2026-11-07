import { describe, expect, test } from "bun:test"
import { cleanName } from "./clean-name"

describe("cleanName", () => {
  test("leaves an ordinary name as it is", () => {
    for (const name of ["readme.txt", "docs/日本語 ファイル.md", "emoji 😀.txt", "a b\u00A0c", "Ça va.txt"]) {
      expect(cleanName(name)).toBe(name)
    }
  })

  test("writes the name in NFC", () => {
    expect(cleanName("cafe\u0301")).toBe("caf\u00E9")
  })

  test.each([
    ["a C0 control", "a\u0007b"],
    ["a newline", "a\nb"],
    ["an escape", "a\u001Bb"],
    ["a NUL", "a\0b"],
    ["DEL", "a\u007Fb"],
    ["a C1 control", "a\u0085b"],
    ["a line separator", "a\u2028b"],
    ["a paragraph separator", "a\u2029b"],
    ["the right-to-left override", "a\u202Eb"],
    ["the left-to-right embedding", "a\u202Ab"],
    ["the right-to-left mark", "a\u200Fb"],
    ["the left-to-right mark", "a\u200Eb"],
    ["the Arabic letter mark", "a\u061Cb"],
    ["a bidi isolate", "a\u2066b"],
    ["a pop isolate", "a\u2069b"],
    ["a zero-width space", "a\u200Bb"],
    ["a zero-width joiner", "a\u200Db"],
    ["the word joiner", "a\u2060b"],
    ["an invisible operator", "a\u2062b"],
    ["a deprecated format character", "a\u206Fb"],
    ["the byte order mark", "a\uFEFFb"],
    ["a soft hyphen", "a\u00ADb"],
    ["the Mongolian vowel separator", "a\u180Eb"],
    ["a Hangul filler", "a\u3164b"],
    ["the halfwidth Hangul filler", "a\uFFA0b"],
    ["the Hangul choseong filler", "a\u115Fb"],
    ["the Hangul jungseong filler", "a\u1160b"],
    ["the combining grapheme joiner", "a\u034Fb"],
    ["a variation selector", "a\uFE01b"],
    ["an interlinear annotation mark", "a\uFFF9b"],
    ["a musical formatting character", "a\u{1D173}b"],
    ["a tag character", "a\u{E0041}b"],
    ["the tag cancel", "a\u{E007F}b"],
  ])("shows %s as ?", (_label, name) => {
    expect(cleanName(name)).toBe("a?b")
  })

  test("keeps the emoji and text presentation selectors and the ideographic variation selectors", () => {
    expect(cleanName("❤\uFE0F.txt")).toBe("❤\uFE0F.txt")
    expect(cleanName("❤\uFE0E.txt")).toBe("❤\uFE0E.txt")
    expect(cleanName("\u8FBB\u{E0100}.txt")).toBe("\u8FBB\u{E0100}.txt")
  })

  test("shows every hidden character, one ? each", () => {
    expect(cleanName("\u202E\u200B\u202Cgnp.exe")).toBe("???gnp.exe")
  })

  test("cuts a name over 255 characters to 255, the last being the cut mark", () => {
    const cut = cleanName("x".repeat(300))
    expect(cut).toBe(`${"x".repeat(254)}…`)
    expect(cleanName("x".repeat(255))).toBe("x".repeat(255))
  })

  test("counts characters, not UTF-16 units, so a cut never splits an emoji", () => {
    const cut = cleanName("😀".repeat(300))
    expect(Array.from(cut)).toHaveLength(255)
    expect(cut).toBe(`${"😀".repeat(254)}…`)
  })
})
