import { encode } from "uqr"

/** Light modules around the code on every side, which a scanner needs to find it. */
export const QR_QUIET_ZONE = 4

/** The darkest grey of the 256-colour palette: themes redefine the first colours of the cube (16 among them), not the grey ramp. */
const DARK = 232
const LIGHT = 231
const RESET = "\x1b[0m"
const HALF_BLOCK = "▀"

function cell(top: boolean, bottom: boolean | undefined): string {
  const foreground = top ? DARK : LIGHT
  const background = bottom === true ? DARK : LIGHT
  return `\x1b[38;5;${foreground}m\x1b[48;5;${background}m${HALF_BLOCK}`
}

/**
 * Draws `text` as a QR code in the terminal: two module rows per line, each cell a half block whose
 * foreground is the upper module and background the lower one, in fixed 256-colour black and white so
 * the theme's palette does not change them. Every line ends with a colour reset; lines are joined with
 * `\n`, with no trailing newline.
 */
export function drawQr(text: string): string {
  const modules = encode(text, { border: QR_QUIET_ZONE }).data
  const lines: string[] = []
  for (let row = 0; row < modules.length; row += 2) {
    const upper = modules[row] ?? []
    const lower = modules[row + 1]
    lines.push(upper.map((top, column) => cell(top, lower?.[column])).join("") + RESET)
  }
  return lines.join("\n")
}
