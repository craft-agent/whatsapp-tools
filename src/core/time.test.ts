import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { ToolError } from "./errors"
import { formatLocalTime, localTimeSchema, parseTimeArgument } from "./time"

const INSTANT = Date.parse("2026-11-07T05:03:12.345Z")

test.each([
  [540, "2026-11-07T14:03:12.345+09:00"],
  [-330, "2026-11-06T23:33:12.345-05:30"],
  [0, "2026-11-07T05:03:12.345+00:00"],
])("formats local time at offset %s", (offset, expected) => {
  const result = formatLocalTime(INSTANT, () => offset)
  expect(result).toBe(expected)
  expect(localTimeSchema.parse(result)).toBe(result)
  expect(Date.parse(result)).toBe(INSTANT)
})

test("uses the local offset at the instant by default", () => {
  expect(formatLocalTime(INSTANT)).toBe(formatLocalTime(INSTANT, (ms) => -new Date(ms).getTimezoneOffset()))
})

const TIME_MODULE = join(import.meta.dir, "time.ts")

/**
 * Reads each text with `parseTimeArgument` in a process started in `zone`. A runtime may fix its zone at the first
 * date it reads, so changing `TZ` inside the test process would leave every later zone reading as the first.
 */
function parsedInZone(zone: string, texts: readonly string[]): number[] {
  const script = `const { parseTimeArgument } = await import(${JSON.stringify(TIME_MODULE)});
console.log(JSON.stringify(${JSON.stringify(texts)}.map((text) => parseTimeArgument(text, "after"))))`
  const run = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: zone }, encoding: "utf8" })
  if (run.status !== 0) throw new Error(`parsing in ${zone} failed: ${run.stderr}`)
  return JSON.parse(run.stdout) as number[]
}

/** What `new Date(...parts)` reads as local time in a process started in `zone`. */
function localDateInZone(zone: string, parts: readonly number[]): number {
  const script = `console.log(new Date(${parts.join(", ")}).getTime())`
  const run = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: zone }, encoding: "utf8" })
  if (run.status !== 0) throw new Error(`reading a date in ${zone} failed: ${run.stderr}`)
  return Number(run.stdout.trim())
}

describe("parseTimeArgument", () => {
  test.each([
    ["2026-11-07T14:03:12.345+09:00", INSTANT],
    ["2026-11-06T23:33:12.345-05:30", INSTANT],
    ["2026-11-07T10:48:12.345+05:45", INSTANT],
    ["2026-11-07T05:03:12.345Z", INSTANT],
    ["2026-11-07t05:03:12.345z", INSTANT],
    ["2026-11-07 14:03:12.345+09:00", INSTANT],
    ["2026-11-07T14:03:12.3456789+09:00", INSTANT],
    ["2026-11-07T14:03+09:00", Date.UTC(2026, 10, 7, 5, 3)],
    ["2026-11-07T14:03:12.5+09:00", Date.UTC(2026, 10, 7, 5, 3, 12, 500)],
  ])("reads %s with its own offset", (text, expected) => {
    expect(parseTimeArgument(text, "after")).toBe(expected)
  })

  test.each([
    ["Asia/Tokyo", Date.UTC(2026, 10, 7, 5, 3)],
    ["Asia/Kolkata", Date.UTC(2026, 10, 7, 8, 33)],
    ["America/New_York", Date.UTC(2026, 10, 7, 19, 3)],
    ["UTC", Date.UTC(2026, 10, 7, 14, 3)],
  ])("a time without an offset is local time in %s", (zone, expected) => {
    expect(parsedInZone(zone, ["2026-11-07T14:03", "2026-11-07T14:03:00.000", "2026-11-07 14:03"])).toEqual([
      expected,
      expected,
      expected,
    ])
  })

  test("a date alone is local midnight", () => {
    expect(parsedInZone("Asia/Tokyo", [" 2026-11-07 "])).toEqual([Date.UTC(2026, 10, 6, 15)])
    expect(parsedInZone("America/New_York", ["2026-11-07"])).toEqual([Date.UTC(2026, 10, 7, 5)])
  })

  test("a local time a clock change skips or repeats is read as Date reads it", () => {
    expect(parsedInZone("America/New_York", ["2026-03-08T02:30", "2026-11-01T01:30"])).toEqual([
      localDateInZone("America/New_York", [2026, 2, 8, 2, 30]),
      localDateInZone("America/New_York", [2026, 10, 1, 1, 30]),
    ])
  })

  test("accepts a real leap day and the last second of a day", () => {
    expect(parseTimeArgument("2024-02-29T23:59:59.999Z", "after")).toBe(Date.UTC(2024, 1, 29, 23, 59, 59, 999))
    expect(parsedInZone("UTC", ["2026-12-31"])).toEqual([Date.UTC(2026, 11, 31)])
  })

  test.each([
    "",
    "yesterday",
    "2026-11-07T",
    "2026-13-07",
    "2026-00-10",
    "2026-02-30",
    "2026-02-29",
    "2026-04-31",
    "0999-11-07",
    "0026-11-07",
    "2026-11-07T24:00",
    "2026-11-07T14:60",
    "2026-11-07T14:03:60",
    "2026-11-07T14:03+24:00",
    "2026-11-07T14:03+09:60",
    "2026-11-07+09:00",
    "2026-11-07T14:03+0900",
    "20261107",
    "2026-11-07T14:03:12.",
  ])("refuses %j, naming the argument and the forms", (text) => {
    let error: unknown
    try {
      parseTimeArgument(text, "before")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect((error as ToolError).message).toContain("before is not a time")
    expect((error as ToolError).message).toContain("2026-11-07T14:03:12+09:00")
  })
})
