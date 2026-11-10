import { ToolError } from "../errors"

/** The most UTF-16 units one emoji has, which bounds a long ZWJ sequence. */
export const MAX_EMOJI_UNITS = 64

/** The locale is fixed, so the same text is one cluster or several on every machine. */
const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" })

const VARIATION_SELECTOR_16 = String.raw`\uFE0F`
const ZERO_WIDTH_JOINER = String.raw`\u200D`

/** Shown as an emoji by default, though it is no emoji alone: a regional indicator is half a flag, a skin tone is a swatch. */
const NOT_A_BASE = String.raw`(?![\p{Regional_Indicator}\p{Emoji_Modifier}])`

/**
 * One element of an emoji, as a picker offers it: a character shown as an
 * emoji by default, or one shown as text by default that VS16 turns into one,
 * with at most one skin tone; or a skin-tone base, which takes its tone
 * without VS16.
 */
const ELEMENT = String.raw`(?:(?:${NOT_A_BASE}\p{Emoji_Presentation}|\p{Extended_Pictographic}${VARIATION_SELECTOR_16})\p{Emoji_Modifier}?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier})`

/** Elements joined by ZWJ: a person, a family, a rainbow flag. */
const SEQUENCE = String.raw`${ELEMENT}(?:${ZERO_WIDTH_JOINER}${ELEMENT})*`

/** A flag is its country's two regional indicators. */
const FLAG = String.raw`\p{Regional_Indicator}{2}`

/** A keycap is a key, an optional VS16 and the combining enclosing keycap. */
const KEYCAP = String.raw`[0-9#*]${VARIATION_SELECTOR_16}?\u20E3`

/** A tag sequence is a black flag, the tag characters of a region, and the cancel tag. */
const TAG_SEQUENCE = String.raw`\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}`

const EMOJI = new RegExp(`^(?:${SEQUENCE}|${FLAG}|${KEYCAP}|${TAG_SEQUENCE})$`, "u")

/**
 * Whether the text is exactly one emoji as a picker offers it: one grapheme cluster that is an emoji presentation
 * sequence (with a skin tone, joined by ZWJ to others), a flag, a keycap or a tag sequence, of at most
 * `MAX_EMOJI_UNITS` UTF-16 units. Anything else in the cluster (a combining mark, a second selector, a symbol shown
 * as text such as © without VS16) is not. Nothing is trimmed.
 */
export function isOneEmoji(text: string): boolean {
  const isOneCluster = [...GRAPHEME_SEGMENTER.segment(text)].length === 1
  return isOneCluster && EMOJI.test(text) && text.length <= MAX_EMOJI_UNITS
}

/** The emoji as given when it is exactly one emoji (see `isOneEmoji`), else `invalid_argument`. Nothing is trimmed. */
export function checkedEmoji(emoji: string): string {
  if (!isOneEmoji(emoji)) throw new ToolError("invalid_argument", "emoji must be exactly one emoji, such as 👍.")
  return emoji
}
