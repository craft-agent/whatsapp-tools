import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { at } from "../chat/read.testing"
import { formatLocalTime } from "../time"
import { CHAT, backfillResponse, createBackfillTest, older, type BackfillTest } from "./backfill.testing"

let t: BackfillTest

beforeEach(async () => {
  t = await createBackfillTest()
})

afterEach(async () => {
  await t.close()
})

describe("a backfill that wacli finished", () => {
  test("reports what the mirror gained, measured by its coverage, and that the service syncs again", async () => {
    await t.serve(backfillResponse({ responses: 2, add: older(3) }))
    const result = await t.run({ chat: CHAT })
    expect(result).toEqual({
      chat: CHAT,
      added: 3,
      held: 5,
      oldest: formatLocalTime(at(5)),
      stopped: "batches_done",
      service_running: true,
      note: expect.stringContaining("best effort"),
    })
    expect(result.note).toContain("nothing added does not prove that nothing older exists")
    expect(result.note).toContain("Asking again is safe")
  })

  test("says start_of_history when the phone reached the start of the chat", async () => {
    await t.serve(backfillResponse({ add: older(2), reason: "start_of_history_reached" }))
    expect(await t.run({ chat: CHAT })).toMatchObject({ added: 2, held: 4, stopped: "start_of_history" })
  })

  test.each(["no_older_messages_added", "no_messages_returned"])(
    "says nothing_older for %s, with the mirror as it was",
    async (reason) => {
      await t.serve(backfillResponse({ reason }))
      expect(await t.run({ chat: CHAT })).toMatchObject({
        added: 0,
        held: 2,
        oldest: formatLocalTime(at(100)),
        stopped: "nothing_older",
      })
    },
  )

  test("says batches_done for a reason it does not know, or for none", async () => {
    await t.serve(backfillResponse({ reason: "something_new" }))
    expect(await t.run({ chat: CHAT })).toMatchObject({ stopped: "batches_done" })
  })

  test("counts what the mirror gained of this chat, not what wacli says it added in all", async () => {
    // The fake's envelope says 99 messages were added.
    await t.serve(backfillResponse({ add: older(1) }))
    expect(await t.run({ chat: CHAT })).toMatchObject({ added: 1, held: 3 })
  })
})

describe("what the tool asks wacli", () => {
  test("runs wacli with the sync stopped, as a write, with the batches and the limits of the request", async () => {
    await t.serve(backfillResponse({ reason: "no_messages_returned" }))
    await t.run({ chat: CHAT, batches: 4 })
    const [call, ...others] = await t.backfillCalls()
    expect(others).toEqual([])
    expect(call?.argv).toEqual([
      "--store",
      t.fixture.paths.store,
      "--json",
      "--events",
      "history",
      "backfill",
      "--chat",
      CHAT,
      "--count",
      "50",
      "--requests",
      "4",
      "--wait",
      "30s",
      "--idle-exit",
      "5s",
    ])
    expect(call?.env).toEqual({ WACLI_MEDIA_ROOTS: t.fixture.paths.outbox })
    expect(t.fixture.logs.filter((line) => line === "event stopping")).toHaveLength(1)
  })

  test("asks for 2 batches unless told otherwise", async () => {
    await t.serve(backfillResponse())
    await t.run({ chat: CHAT })
    const [call] = await t.backfillCalls()
    expect(call?.argv.slice(call.argv.indexOf("--requests"), call.argv.indexOf("--requests") + 2)).toEqual([
      "--requests",
      "2",
    ])
  })

  test("names a person by the JID without the device suffix", async () => {
    await t.serve(backfillResponse())
    const result = await t.run({ chat: "15550100001:7@s.whatsapp.net" })
    expect(result.chat).toBe(CHAT)
    const [call] = await t.backfillCalls()
    expect(call?.argv).toContain(CHAT)
  })

  test("starts the sync child again, once, after it", async () => {
    await t.serve(backfillResponse({ add: older(1) }))
    await t.run({ chat: CHAT })
    await t.childBack(2)
    expect(t.fixture.status()?.state).toBe("running")
  })
})
