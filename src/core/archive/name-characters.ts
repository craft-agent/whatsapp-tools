/**
 * Characters that make a name read as another on disk: the C0 and C1
 * controls and DEL (which a terminal acts on), and the bidi controls
 * (U+061C, U+200E/F, U+202A–202E, U+2066–2069), which reorder what is shown.
 * Other invisible characters are not here: ZWJ and ZWNJ are part of emoji and
 * of Persian and Indic names, so they pass and are only cleaned in a listing
 * (`cleanName`).
 */
const MISLEADING_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/

/** Whether a file or path name holds a control or bidi control character, which no name that is kept or written may. */
export function hasMisleadingCharacters(name: string): boolean {
  return MISLEADING_CHARACTERS.test(name)
}
