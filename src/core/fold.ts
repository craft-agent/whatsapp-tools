/**
 * Folds text for a case-insensitive match: compatibility forms unified, then
 * upper- and lower-cased, so `ß` meets `ss`; lower-casing writes a word-final
 * sigma as `ς`, which is turned back into `σ` so it meets a sigma anywhere.
 */
export function foldCase(text: string): string {
  return text.normalize("NFKC").toUpperCase().toLowerCase().replace(/ς/g, "σ")
}
