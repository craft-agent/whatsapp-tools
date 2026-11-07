/** The most characters of a name or file name a result carries; a longer one is cut and says so. */
export const MAX_NAME_LENGTH = 256

/** `text` cut after `MAX_NAME_LENGTH` characters, counted by code point so that no pair is split; `cut` says whether it was. */
export function capName(text: string): { text: string; cut: boolean } {
  let end = 0
  let count = 0
  for (const point of text) {
    if (count === MAX_NAME_LENGTH) return { text: text.slice(0, end), cut: true }
    end += point.length
    count += 1
  }
  return { text, cut: false }
}

/** The `name` of a chat in a result, trimmed and capped (null when empty), with `name_cut` set when it was cut. */
export function chatNameFields(name: string): { name: string | null; name_cut?: true } {
  const { text, cut } = capName(name.trim())
  return { name: text || null, ...(cut ? { name_cut: true as const } : {}) }
}
