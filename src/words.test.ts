import { describe, expect, test } from "bun:test"
import { translator } from "./core"
import { FACT_TRANSLATIONS } from "./core/facts"
import { FILE_SAVE_WORDS } from "./core/file/words"
import { HISTORY_WORDS } from "./core/history/words"
import { MESSAGE_WORDS } from "./core/message/words"
import { ALL_TOOLS } from "./tools"
import { ALL_TRANSLATIONS } from "./words"

/** Every English word and template the tools write in their approval prompts; each domain appends its own. */
const ENGLISH_WORDS: string[] = [
  ...Object.values(MESSAGE_WORDS),
  ...Object.values(FILE_SAVE_WORDS),
  ...Object.values(HISTORY_WORDS),
  ...Object.keys(FACT_TRANSLATIONS.ja!),
]

const JAPANESE = ALL_TRANSLATIONS.ja!

describe("ALL_TRANSLATIONS", () => {
  test("holds exactly the words the tools write", () => {
    expect(new Set(Object.keys(JAPANESE))).toEqual(new Set(ENGLISH_WORDS))
  })

  test("translates the title and the intent of every write tool that has an intent", () => {
    const keys = new Set(Object.keys(JAPANESE))
    for (const tool of ALL_TOOLS.filter((spec) => spec.class !== "read" && spec.intent !== undefined)) {
      expect(keys.has(tool.title)).toBe(true)
      expect(keys.has(tool.intent!)).toBe(true)
    }
  })

  test("keeps the placeholders of every template and fits its limits", () => {
    const ja = translator(ALL_TRANSLATIONS, "ja")
    for (const word of ENGLISH_WORDS) {
      const translated = word.includes("{") ? ja.template(word) : ja.word(word)
      expect(translated).toBe(JAPANESE[word]!)
    }
  })
})
