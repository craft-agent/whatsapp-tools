import { mergeTranslations, type Translations } from "./core"
import { FACT_TRANSLATIONS } from "./core/facts"
import { MESSAGE_TRANSLATIONS } from "./core/message/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(MESSAGE_TRANSLATIONS, FACT_TRANSLATIONS)
