import { describe, expect, test } from "bun:test"
import { hasMisleadingCharacters } from "./name-characters"

describe("hasMisleadingCharacters", () => {
  test.each([
    "\u0000",
    "\u0001",
    "\n",
    "\u001B",
    "\u001F",
    "\u007F",
    "\u0080",
    "\u0085",
    "\u009F",
    "\u061C",
    "\u200E",
    "\u200F",
    "\u202A",
    "\u202B",
    "\u202C",
    "\u202D",
    "\u202E",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
  ])("finds %j inside a name", (character) => {
    expect(hasMisleadingCharacters(`a${character}b.txt`)).toBe(true)
  })

  test.each([
    "readme.txt",
    "日本語 ファイル.md",
    "emoji 😀.txt",
    "a b\u00A0c",
    "a\u200Db",
    "a\u200Cb",
    "a\u200Bb",
    "\uFEFFa",
  ])("lets %j pass", (name) => {
    expect(hasMisleadingCharacters(name)).toBe(false)
  })

  test("lets the characters either side of the ranges pass", () => {
    for (const character of ["\u0020", "\u00A0", "\u061B", "\u200D", "\u2029", "\u202F", "\u2065", "\u206A"]) {
      expect(hasMisleadingCharacters(character)).toBe(false)
    }
  })
})
