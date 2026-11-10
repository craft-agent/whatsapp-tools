import { mergeTranslations, type Translations } from "./core"
import { FACT_TRANSLATIONS } from "./core/facts"
import { FILE_SEND_TRANSLATIONS } from "./core/file/send/words"
import { FILE_SAVE_TRANSLATIONS } from "./core/file/words"
import { HISTORY_TRANSLATIONS } from "./core/history/words"
import { EDIT_TRANSLATIONS } from "./core/message/edit/words"
import { REACT_TRANSLATIONS } from "./core/message/react/words"
import { MESSAGE_TRANSLATIONS } from "./core/message/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  MESSAGE_TRANSLATIONS,
  EDIT_TRANSLATIONS,
  REACT_TRANSLATIONS,
  FILE_SAVE_TRANSLATIONS,
  FILE_SEND_TRANSLATIONS,
  HISTORY_TRANSLATIONS,
  FACT_TRANSLATIONS,
)
