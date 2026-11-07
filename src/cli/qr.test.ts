import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { encode } from "uqr"
import { drawQr, QR_QUIET_ZONE } from "./qr"

const RESET = "\x1b[0m"
const CELL = /^\x1b\[38;5;(\d+)m\x1b\[48;5;(\d+)m▀$/
const DARK = "232"
const LIGHT = "231"

const URLS = {
  "a pairing payload": [
    `2@${randomBytes(66).toString("base64")}`,
    ...[1, 2, 3].map(() => randomBytes(32).toString("base64")),
  ].join(","),
  "a short text with an odd module count": "hi",
}

/** Splits a line into its cells, without the closing reset. */
function cellsOf(line: string): string[] {
  expect(line.endsWith(RESET)).toBe(true)
  return line.slice(0, -RESET.length).match(/\x1b\[38;5;\d+m\x1b\[48;5;\d+m▀/g) ?? []
}

/** Reads the drawing back into modules; an odd matrix's missing last row is dropped. */
function decode(drawing: string, rows: number): boolean[][] {
  const modules: boolean[][] = []
  for (const line of drawing.split("\n")) {
    const upper: boolean[] = []
    const lower: boolean[] = []
    for (const cell of cellsOf(line)) {
      const [, foreground, background] = CELL.exec(cell) ?? []
      expect([DARK, LIGHT]).toContain(foreground)
      expect([DARK, LIGHT]).toContain(background)
      upper.push(foreground === DARK)
      lower.push(background === DARK)
    }
    modules.push(upper, lower)
  }
  return modules.slice(0, rows)
}

describe("drawQr", () => {
  for (const [name, text] of Object.entries(URLS)) {
    describe(name, () => {
      const matrix = encode(text, { border: QR_QUIET_ZONE }).data
      const drawing = drawQr(text)
      const lines = drawing.split("\n")

      test("decodes back to the module matrix", () => {
        expect(decode(drawing, matrix.length)).toEqual(matrix)
      })

      test("is as wide as the code and half as high", () => {
        expect(lines).toHaveLength(Math.ceil(matrix.length / 2))
        for (const line of lines) expect(cellsOf(line)).toHaveLength(matrix.length)
      })

      test("keeps a light quiet zone on every side", () => {
        const modules = decode(drawing, matrix.length)
        const last = modules.length - 1
        for (let edge = 0; edge < QR_QUIET_ZONE; edge++) {
          expect(modules[edge]?.some(Boolean)).toBe(false)
          expect(modules[last - edge]?.some(Boolean)).toBe(false)
          expect(modules.some((row) => row[edge] || row[last - edge])).toBe(false)
        }
      })

      test("ends every line with a reset, with no trailing newline", () => {
        for (const line of lines) expect(line.endsWith(RESET)).toBe(true)
        expect(drawing.endsWith("\n")).toBe(false)
      })

      test("uses only the two fixed colours", () => {
        const colours = new Set(Array.from(drawing.matchAll(/\x1b\[[34]8;5;(\d+)m/g), (match) => match[1]))
        expect([...colours].sort()).toEqual([DARK, LIGHT].sort())
      })
    })
  }

  test("pairs an odd last row with a light one", () => {
    const matrix = encode("hi", { border: QR_QUIET_ZONE }).data
    expect(matrix.length % 2).toBe(1)
    const last = drawQr("hi").split("\n").at(-1) ?? ""
    for (const cell of cellsOf(last)) expect(CELL.exec(cell)?.[2]).toBe(LIGHT)
  })
})
