/** What a masked phone number or JID user part is replaced with. */
export const MASK = "<number>"

/**
 * What counts as a number: `+` and six or more digits, each optionally preceded by a space or a dash; the user
 * part of a JID (the digits, and a device suffix, before `@`); and any other run of six or more digits.
 */
const NUMBER_PATTERN = /\+(?:[ -]?\d){6,}|\d+(?::\d+)?(?=@)|\d{6,}/g

/** Replaces phone numbers and the user part of JIDs with `<number>`, so none reaches an error or a log. */
export function maskNumbers(text: string): string {
  return text.replace(NUMBER_PATTERN, MASK)
}
