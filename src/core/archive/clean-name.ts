/** The longest a listed name is, in characters, the cut mark included. */
const MAX_NAME_CHARACTERS = 255
const CUT_MARK = "…"

/**
 * Characters that show nothing or reorder what is shown, so a name could read
 * as another: C0 and C1 controls, DEL, the line and paragraph separators,
 * soft hyphen, the combining grapheme joiner, the Arabic letter mark, the
 * Hangul and Khmer fillers, Mongolian variation selectors and vowel
 * separator, zero-width characters, the bidi controls (U+200E/F, U+202A–202E,
 * U+2066–2069), word joiner and the invisible operators (U+2060–206F), the
 * variation selectors U+FE00–FE0D, the byte order mark, the interlinear
 * annotation marks and object replacement character, the musical formatting
 * characters, and the tag characters.
 *
 * U+FE0E and U+FE0F (text and emoji presentation) and the ideographic
 * variation selectors U+E0100–E01EF stay: they are how real emoji and
 * Japanese names are written, and each selects a glyph that can be seen.
 */
const HIDDEN_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\uFFF9-\uFFFC\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}]/gu

/**
 * A name as it is listed: in NFC, with each hidden or reordering character
 * (see `HIDDEN_CHARACTERS`) shown as `?`, and cut to 255 characters with `…`.
 * Only the listing uses it; the checks run on the name as the archive wrote it.
 */
export function cleanName(text: string): string {
  const cleaned = text.normalize("NFC").replace(HIDDEN_CHARACTERS, "?")
  const characters = Array.from(cleaned)
  if (characters.length <= MAX_NAME_CHARACTERS) return cleaned
  return characters.slice(0, MAX_NAME_CHARACTERS - CUT_MARK.length).join("") + CUT_MARK
}
