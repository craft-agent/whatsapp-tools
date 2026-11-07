import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { ToolError } from "./errors"
import {
  NEXT_RESERVE,
  RESULT_BUDGET,
  clampLimit,
  cutText,
  decodeCursor,
  encodeCursor,
  fingerprint,
  fitItems,
  readCursor,
  type Cuttable,
} from "./pages"

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof ToolError) return `${error.code}: ${error.message}`
    throw error
  }
  throw new Error("expected the function to throw")
}

describe("clampLimit", () => {
  const rule = { default: 30, max: 200 }

  test("uses the default, keeps a value in range and clamps one above the largest", () => {
    expect(clampLimit(undefined, rule, "limit")).toBe(30)
    expect(clampLimit(1, rule, "limit")).toBe(1)
    expect(clampLimit(200, rule, "limit")).toBe(200)
    expect(clampLimit(201, rule, "limit")).toBe(200)
    expect(clampLimit(1_000_000, rule, "limit")).toBe(200)
  })

  test.each([0, -3, 1.5, Number.NaN])("refuses %p, naming the argument and the largest", (limit) => {
    expect(codeOf(() => clampLimit(limit, rule, "limit"))).toBe(
      "invalid_argument: limit must be a whole number of at least 1; the largest is 200.",
    )
  })
})

describe("cursors", () => {
  test("round trip any object, and read as URL-safe text", () => {
    const value = { ts: 1_800_000_000_000, id: "group:a+b/c==", name: "Ä ☃ 🙂" }
    const text = encodeCursor(value)
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(text, "cursor")).toEqual(value)
  })

  test.each(["", "!!!", "not a cursor", "e30=", "bm90LWpzb24", encodeCursor({}).slice(0, -1)])(
    "refuses %j as not a cursor this tool returned",
    (text) => {
      expect(codeOf(() => decodeCursor(text, "cursor"))).toBe(
        "invalid_argument: cursor is not a cursor this tool returned.",
      )
    },
  )

  test("readCursor refuses a cursor of another shape the same way", () => {
    const schema = z.object({ ts: z.number() })
    expect(readCursor(encodeCursor({ ts: 5 }), "cursor", schema)).toEqual({ ts: 5 })
    for (const text of [encodeCursor({ ts: "5" }), encodeCursor([1]), encodeCursor({ id: 1 }), "garbage"]) {
      expect(codeOf(() => readCursor(text, "cursor", schema))).toContain("is not a cursor this tool returned")
    }
  })
})

describe("fingerprint", () => {
  test("is short, URL-safe and the same for the same parts", () => {
    const text = fingerprint("query", true, undefined)
    expect(text).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(fingerprint("query", true, undefined)).toBe(text)
    expect(fingerprint("x".repeat(10_000))).toHaveLength(16)
  })

  test("differs when any part, or the order of the parts, differs", () => {
    const texts = [
      fingerprint("a", "b"),
      fingerprint("b", "a"),
      fingerprint("a", "b", false),
      fingerprint("ab"),
      fingerprint("a", undefined),
      fingerprint("a", null),
    ]
    expect(new Set(texts).size).toBe(texts.length - 1)
    expect(fingerprint("a", undefined)).toBe(fingerprint("a", null))
  })
})

describe("fitItems", () => {
  const assemble = (items: string[]) => ({ note: "n", items })

  test("takes every candidate when they fit", () => {
    expect(fitItems(assemble, ["a", "b", "c"])).toEqual({ items: ["a", "b", "c"], stopped: false })
    expect(fitItems(assemble, [])).toEqual({ items: [], stopped: false })
  })

  test("stops before the candidate that would push the result past the budget, leaving room for next", () => {
    const item = "x".repeat(10_000)
    const { items, stopped } = fitItems(assemble, [item, item, item, item, item, item])
    expect(stopped).toBe(true)
    expect(items).toHaveLength(4)
    const length = JSON.stringify(assemble(items)).length
    expect(length).toBeLessThanOrEqual(RESULT_BUDGET - NEXT_RESERVE)
    expect(length + JSON.stringify({ next: "y".repeat(NEXT_RESERVE - 10) }).length).toBeLessThan(RESULT_BUDGET)
  })

  test("measures the result as the caller assembles it, escapes and all", () => {
    const item = '"\n'.repeat(10_000)
    const { items } = fitItems(assemble, [item, item, item])
    expect(items).toHaveLength(1)
    expect(JSON.stringify(assemble(items)).length).toBeLessThanOrEqual(RESULT_BUDGET)
  })

  test("measures a next that the assembled result builds from the items taken, so no reserve is left for it", () => {
    const build = (items: string[]) => ({ items, next: "n".repeat(items.length * 100) })
    const item = "x".repeat(1000)
    const { items, stopped } = fitItems(
      build,
      Array.from({ length: 100 }, () => item),
      { reserve: 0 },
    )
    expect(stopped).toBe(true)
    expect(JSON.stringify(build(items)).length).toBeLessThan(RESULT_BUDGET)
    expect(JSON.stringify(build([...items, item])).length).toBeGreaterThanOrEqual(RESULT_BUDGET)
  })

  test("a first item is cut to leave room for the next its own result carries", () => {
    type Piece = { text: string; text_cut?: true }
    const text: Cuttable<Piece> = {
      size: (item) => item.text.length,
      cut: (item, keep) => (keep >= item.text.length ? item : { text: item.text.slice(0, keep), text_cut: true }),
    }
    const build = (items: Piece[]) => ({ items, next: "n".repeat(5000) })
    const { items } = fitItems(build, [{ text: "x".repeat(RESULT_BUDGET) }, { text: "b" }], {
      reserve: 0,
      cuttable: text,
    })
    const length = JSON.stringify(build(items)).length
    expect(length).toBeLessThan(RESULT_BUDGET)
    expect(length).toBeGreaterThan(RESULT_BUDGET - 10)
    expect(items[0]?.text_cut).toBe(true)
  })

  test("an item that alone exceeds the budget is taken whole without a way to cut it", () => {
    const item = "x".repeat(RESULT_BUDGET * 2)
    expect(fitItems(assemble, [item])).toEqual({ items: [item], stopped: false })
    expect(fitItems(assemble, [item, "b"])).toEqual({ items: [item], stopped: true })
  })

  type Piece = { text: string; text_cut?: true }
  const text: Cuttable<Piece> = {
    size: (item) => item.text.length,
    cut: (item, keep) => (keep >= item.text.length ? item : { text: item.text.slice(0, keep), text_cut: true }),
  }

  test("an oversized first item is cut as little as the budget allows", () => {
    const item: Piece = { text: "x".repeat(RESULT_BUDGET * 2) }
    const build = (items: Piece[]) => ({ note: "n", items })
    const { items, stopped } = fitItems(build, [item, { text: "b" }], { cuttable: text })
    expect(stopped).toBe(true)
    expect(items).toHaveLength(1)
    const length = JSON.stringify(build(items)).length
    expect(length).toBeLessThanOrEqual(RESULT_BUDGET - NEXT_RESERVE)
    expect(length).toBeGreaterThan(RESULT_BUDGET - NEXT_RESERVE - 10)
    expect(items[0]?.text_cut).toBe(true)
  })

  test("escapes make a cut item longer, so fewer characters are kept", () => {
    const item: Piece = { text: "\n".repeat(RESULT_BUDGET) }
    const build = (items: Piece[]) => ({ items })
    const { items } = fitItems(build, [item], { cuttable: text })
    expect(JSON.stringify(build(items)).length).toBeLessThanOrEqual(RESULT_BUDGET - NEXT_RESERVE)
    expect(items[0]?.text.length).toBeLessThan(RESULT_BUDGET / 2)
  })

  test("an item that fits is not cut, and a later oversized item is left for the next page", () => {
    const small: Piece = { text: "a" }
    const big: Piece = { text: "x".repeat(RESULT_BUDGET) }
    const build = (items: Piece[]) => ({ items })
    expect(fitItems(build, [small, big], { cuttable: text })).toEqual({ items: [small], stopped: true })
  })

  test("metadata is dropped one piece at a time, only until the item fits, and the text then gets the room left", () => {
    type Rich = { text: string; extra: string[]; fixed?: string; dropped?: number }
    const rich: Cuttable<Rich> = {
      size: (item) => item.text.length,
      cut: (item, keep) => ({ ...item, text: item.text.slice(0, keep) }),
      drop: (item) =>
        item.extra.length === 0 ? null : { ...item, extra: item.extra.slice(1), dropped: (item.dropped ?? 0) + 1 },
    }
    const build = (items: Rich[]) => ({ items })
    const piece = "e".repeat(30_000)
    const item: Rich = { text: "t".repeat(30_000), extra: [piece, piece, piece, "tiny"] }
    const fitted = fitItems(build, [item], { cuttable: rich }).items[0]
    expect(fitted?.dropped).toBe(2)
    expect(fitted?.extra).toEqual([piece, "tiny"])
    expect(fitted?.text.length).toBeGreaterThan(10_000)
    expect(fitted?.text.length).toBeLessThan(20_000)
    const hopeless: Rich = { text: "t", extra: [piece], fixed: "f".repeat(RESULT_BUDGET) }
    expect(fitItems(build, [hopeless], { cuttable: rich }).items[0]).toMatchObject({ text: "", extra: [], dropped: 1 })
  })

  test("cutText never ends in the middle of a surrogate pair", () => {
    expect(cutText("a😀b", 2)).toBe("a")
    expect(cutText("a😀b", 3)).toBe("a😀")
    expect(cutText("abc", 10)).toBe("abc")
    expect(cutText("abc", 0)).toBe("")
  })

  test("a reserve of its own replaces the default", () => {
    const item = "x".repeat(20_000)
    expect(fitItems(assemble, [item, item, item], { reserve: 20_000 }).items).toHaveLength(1)
    expect(fitItems(assemble, [item, item, item], { reserve: 0 }).items).toHaveLength(2)
  })
})
