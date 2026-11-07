import { describe, expect, test } from "bun:test"
import { maskNumbers } from "./mask"

const NUMBER = "15550000000"

describe("maskNumbers", () => {
  test("replaces numbers and the user part of JIDs", () => {
    expect(maskNumbers(`+${NUMBER} wrote to ${NUMBER}@s.whatsapp.net`)).toBe(
      "<number> wrote to <number>@s.whatsapp.net",
    )
    expect(maskNumbers("from 98765432101@lid, device 98765432101:12@lid")).toBe(
      "from <number>@lid, device <number>@lid",
    )
    expect(maskNumbers("+1 555 000 0000 and 12345@lid")).toBe("<number> and <number>@lid")
  })

  test("leaves short numbers and ordinary text alone", () => {
    expect(maskNumbers("exited with code 1 after 5 s; 12345 items; 0.26.0")).toBe(
      "exited with code 1 after 5 s; 12345 items; 0.26.0",
    )
  })
})
