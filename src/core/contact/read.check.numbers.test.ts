import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { readNumbers } from "./check"
import { createContactFixture, type ContactFixture } from "./read.testing"

let fixture: ContactFixture

beforeEach(async () => {
  fixture = await createContactFixture()
})

afterEach(() => fixture.close())

/** The `ToolError` that reading `numbers` throws. */
function refusal(numbers: string[] | undefined): ToolError {
  try {
    readNumbers(numbers)
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("expected the numbers to be refused")
}

describe("the numbers of check", () => {
  test("loses the spaces, dots, dashes and brackets of a number as typed", () => {
    expect(readNumbers(["+1 (555) 010-0001", "+1.555.010.0002", "+1[555]0100003", "+15550100004 "])).toEqual([
      "+15550100001",
      "+15550100002",
      "+15550100003",
      "+15550100004",
    ])
  })

  test("merges duplicates, keeping the order they were first given in", () => {
    expect(readNumbers(["+15550100002", "+1 555 010 0001", "+15550100002", "+15550100001"])).toEqual([
      "+15550100002",
      "+15550100001",
    ])
  })

  test("takes the shortest and the longest number, and 20 numbers", () => {
    expect(readNumbers(["+1234567", "+123456789012345"])).toEqual(["+1234567", "+123456789012345"])
    const twenty = Array.from({ length: 20 }, (_, n) => `+155501000${String(n).padStart(2, "0")}`)
    expect(readNumbers(twenty)).toEqual(twenty)
  })

  test("refuses a number that is not + and 7 to 15 digits, the first not 0, naming the entry and not echoing it", () => {
    const bad = [
      "15550100001",
      "+05550100001",
      "+123456",
      "+1234567890123456",
      "+1555abc0001",
      "",
      "ann",
      "+",
      "++15550100001",
    ]
    for (const number of bad) {
      const error = refusal(["+15550100001", number])
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("numbers entry 2 must be + and 7 to 15 digits, the first not 0")
      if (number.length > 3) expect(error.message).not.toContain(number)
    }
  })

  test("refuses none, and more than 20, explaining that many lookups get an account limited", () => {
    for (const none of [undefined, []]) {
      expect(refusal(none).message).toContain("numbers is required for check")
    }
    const error = refusal(Array.from({ length: 21 }, (_, n) => `+155501000${String(n).padStart(2, "0")}`))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("at most 20")
    expect(error.message).toContain("limited")
  })

  test("is checked before the service is asked: a bad number needs no service and runs no wacli", async () => {
    const error = await fixture.failure({ method: "check", numbers: ["+15550100001", "12"] })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("entry 2")
    expect((await fixture.fake.calls()).filter((call) => call.argv[0] !== "version")).toEqual([])
  })
})
