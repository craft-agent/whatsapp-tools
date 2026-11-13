import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { decodeCursor } from "../pages"
import { ANN, BOB, CY, HIDDEN, createContactFixture, wacliContact, type ContactFixture } from "./read.testing"

let fixture: ContactFixture

beforeEach(async () => {
  fixture = await createContactFixture()
  fixture.setContacts(
    wacliContact(ANN, "Name A"),
    wacliContact(BOB, "Name B"),
    wacliContact(CY, "Name C"),
    wacliContact(HIDDEN, "Name D"),
  )
})

afterEach(() => fixture.close())

const idsOf = async (args: Record<string, unknown> = {}) =>
  (await fixture.read({ method: "search", query: "Name", ...args })).contacts?.map((contact) => contact.id)

describe("contact search with excluded chats", () => {
  test("leaves out an excluded JID and keeps the others in order", async () => {
    fixture.exclude(BOB, HIDDEN)
    expect(await idsOf()).toEqual([ANN, CY])
  })

  test("matches a contact filed under a device JID of an excluded person", async () => {
    fixture.setContacts(wacliContact("15550100002:7@s.whatsapp.net", "Name B"), wacliContact(ANN, "Name A"))
    fixture.exclude(BOB)
    expect(await idsOf()).toEqual([ANN])
  })

  test("drops the excluded contacts before paging, so a page is as full as it would be without them", async () => {
    fixture.exclude(ANN, BOB)
    const first = await fixture.read({ method: "search", query: "Name", limit: 1 })
    expect(first.contacts?.map((contact) => contact.id)).toEqual([CY])
    expect(first.next).toBeDefined()
    const second = await fixture.read({ method: "search", query: "Name", limit: 1, cursor: first.next })
    expect(second.contacts?.map((contact) => contact.id)).toEqual([HIDDEN])
    expect(second.next).toBeUndefined()
  })

  test("refuses a cursor taken under another setting, and a cursor carries no excluded JID", async () => {
    fixture.exclude(BOB)
    const first = await fixture.read({ method: "search", query: "Name", limit: 1 })
    const cursor = JSON.stringify(decodeCursor(first.next!, "cursor"))
    expect(cursor).not.toContain(BOB)
    expect(cursor).not.toContain("15550100002")
    expect((await idsOf({ limit: 1, cursor: first.next }))?.length).toBe(1)

    fixture.exclude(BOB, CY)
    expect((await fixture.failure({ method: "search", query: "Name", limit: 1, cursor: first.next })).code).toBe(
      "invalid_argument",
    )
    fixture.exclude()
    expect((await fixture.failure({ method: "search", query: "Name", limit: 1, cursor: first.next })).code).toBe(
      "invalid_argument",
    )
  })

  test("binds a cursor to the set and not to the order it was given in", async () => {
    fixture.exclude(BOB, CY)
    const first = await fixture.read({ method: "search", query: "Name", limit: 1 })
    fixture.exclude(CY, BOB)
    expect((await idsOf({ limit: 1, cursor: first.next }))?.length).toBe(1)
  })
})
