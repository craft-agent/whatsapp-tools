import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RESULT_BUDGET } from "../pages"
import { createContactFixture, wacliContact, type ContactFixture } from "./read.testing"
import type { ContactReadOutput } from "./schema"

let fixture: ContactFixture

beforeEach(async () => {
  fixture = await createContactFixture()
})

afterEach(() => fixture.close())

const jidOf = (n: number) => `${15550200000 + n}@s.whatsapp.net`

/** `count` contacts named `Name 00`, `Name 01`, …, listed in reverse so the order is the tool's. */
function nameds(count: number, name = (n: number) => `Name ${String(n).padStart(2, "0")}`) {
  return Array.from({ length: count }, (_, n) => wacliContact(jidOf(n), name(n))).reverse()
}

/** Every page of a search, following `next`. */
async function pages(args: Record<string, unknown>): Promise<ContactReadOutput[]> {
  const found: ContactReadOutput[] = []
  let cursor: string | undefined
  do {
    const page = await fixture.read({ method: "search", ...args, ...(cursor ? { cursor } : {}) })
    found.push(page)
    cursor = page.next
  } while (cursor)
  return found
}

const idsOf = (found: ContactReadOutput[]) => found.flatMap((page) => (page.contacts ?? []).map((c) => c.id))

describe("search paging", () => {
  test("pages by name with a cursor, each contact once, `next` only while there is more", async () => {
    fixture.setContacts(...nameds(7))
    const found = await pages({ query: "Name", limit: 3 })
    expect(found.map((page) => page.contacts?.length)).toEqual([3, 3, 1])
    expect(found.map((page) => page.next === undefined)).toEqual([false, false, true])
    expect(idsOf(found)).toEqual(Array.from({ length: 7 }, (_, n) => jidOf(n)))
  })

  test("gives the default of 30 and lowers a limit above 200", async () => {
    fixture.setContacts(...nameds(250, (n) => `Name ${String(n).padStart(3, "0")}`))
    expect((await fixture.read({ method: "search", query: "Name" })).contacts).toHaveLength(30)
    expect((await fixture.read({ method: "search", query: "Name", limit: 5000 })).contacts).toHaveLength(200)
  })

  test("refuses a limit below 1", async () => {
    fixture.setContacts(...nameds(2))
    for (const limit of [0, -4]) {
      expect((await fixture.failure({ method: "search", query: "Name", limit })).code).toBe("invalid_argument")
    }
  })

  test("continues after the cursor's name even when a contact appears or goes between pages", async () => {
    fixture.setContacts(...nameds(6))
    const first = await fixture.read({ method: "search", query: "Name", limit: 3 })
    fixture.setContacts(
      ...nameds(6).filter((contact) => contact.jid !== jidOf(0)),
      wacliContact(jidOf(90), "Name 00 new"),
      wacliContact(jidOf(91), "Name 02b"),
    )
    const second = await fixture.read({ method: "search", query: "Name", limit: 10, cursor: first.next })
    expect(second.contacts?.map((contact) => contact.name)).toEqual(["Name 02b", "Name 03", "Name 04", "Name 05"])
  })

  test("orders contacts without a name after the cursor's last named one", async () => {
    fixture.setContacts(wacliContact(jidOf(1), "Ann"), wacliContact(jidOf(2), ""), wacliContact(jidOf(3), ""))
    const found = await pages({ query: "@", limit: 1 })
    expect(idsOf(found)).toEqual([jidOf(1), jidOf(2), jidOf(3)])
  })

  test("refuses a cursor from another query, another account or that it did not return", async () => {
    fixture.setContacts(...nameds(4))
    const first = await fixture.read({ method: "search", query: "Name", limit: 2 })
    expect((await fixture.failure({ method: "search", query: "name 0", limit: 2, cursor: first.next })).code).toBe(
      "invalid_argument",
    )
    for (const cursor of ["nope", "e30", Buffer.from('{"key":1}').toString("base64url")]) {
      expect((await fixture.failure({ method: "search", query: "Name", cursor })).code).toBe("invalid_argument")
    }
    expect(
      (await fixture.read({ method: "search", query: "Name", limit: 2, cursor: first.next })).contacts,
    ).toHaveLength(2)
  })

  test("keeps a page, `next` included, within the result budget and loses no contact", async () => {
    fixture.setContacts(...nameds(200, (n) => `${String(n).padStart(3, "0")} ${"x".repeat(250)}`))
    const found = await pages({ query: "x", limit: 200 })
    expect(found.length).toBeGreaterThan(1)
    for (const page of found) expect(JSON.stringify(page).length).toBeLessThan(RESULT_BUDGET)
    expect(idsOf(found)).toEqual(Array.from({ length: 200 }, (_, n) => jidOf(n)))
  })
})
