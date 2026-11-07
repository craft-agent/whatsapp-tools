/** The characters of code page 437 from byte 0x80 up, which zip names use when they do not say they are UTF-8. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0"

const ASCII_END = 0x80

// `ignoreBOM` keeps a leading U+FEFF in the text, so a name that starts with one stays visible to the checks.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const LOSSY_UTF8 = new TextDecoder("utf-8", { ignoreBOM: true })

/** Decodes UTF-8, or `undefined` when the bytes are not valid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return STRICT_UTF8.decode(bytes)
  } catch {
    return undefined
  }
}

/** Decodes UTF-8 for display, with `\uFFFD` for what is not valid. */
export function decodeUtf8Lossy(bytes: Uint8Array): string {
  return LOSSY_UTF8.decode(bytes)
}

/** Decodes code page 437, where every byte is a character. */
export function decodeCp437(bytes: Uint8Array): string {
  let text = ""
  for (const byte of bytes) text += byte < ASCII_END ? String.fromCharCode(byte) : CP437_HIGH[byte - ASCII_END]
  return text
}
