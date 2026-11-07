import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { at } from "../chat/read.testing"
import { formatLocalTime } from "../time"
import { CHAT, HELD_MIRROR, backfillResponse, createBackfillTest, older, type BackfillTest } from "./backfill.testing"

let t: BackfillTest

beforeEach(async () => {
  t = await createBackfillTest()
})

afterEach(async () => {
  await t.close()
})

const NO_ANSWER = "timed out waiting for on-demand history sync response (anchor 3EB0A1)"

/** The sync child is started again after every outcome, a failure included. */
const startedAgain = () => t.childBack(2)

describe("a phone that does not answer", () => {
  test("is upstream_error when nothing arrived at all, saying that asking again is safe", async () => {
    await t.serve(backfillResponse({ responses: 0, failed: NO_ANSWER }))
    const error = await t.failure({ chat: CHAT })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("phone did not answer")
    expect(error.message).toContain("nothing was added")
    expect(error.message).toContain("Asking again is safe")
    await startedAgain()
  })

  test("is no_answer when it stopped answering after some messages arrived", async () => {
    await t.serve(backfillResponse({ add: older(2), failed: NO_ANSWER }))
    expect(await t.run({ chat: CHAT, batches: 3 })).toMatchObject({
      added: 2,
      held: 4,
      oldest: formatLocalTime(at(5)),
      stopped: "no_answer",
      service_running: true,
    })
    await startedAgain()
  })

  test("is no_answer when the phone answered but sent nothing, since it did answer", async () => {
    await t.serve(backfillResponse({ responses: 2, failed: NO_ANSWER }))
    expect(await t.run({ chat: CHAT })).toMatchObject({ added: 0, held: 2, stopped: "no_answer" })
  })
})

describe("the time limit of the wacli call", () => {
  test("is upstream_error when nothing arrived before it", async () => {
    await t.serve(backfillResponse({ responses: 0, also: { hang: true } }), { limits: { wacliMs: 300 } })
    const error = await t.failure({ chat: CHAT })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("phone did not answer")
    await startedAgain()
  })

  test("is time_limit when some messages arrived before it", async () => {
    await t.serve(backfillResponse({ add: older(2), also: { hang: true } }), { limits: { wacliMs: 2_000 } })
    expect(await t.run({ chat: CHAT })).toMatchObject({ added: 2, held: 4, stopped: "time_limit" })
    await startedAgain()
  })
})

describe("any other failure of wacli", () => {
  test("is stopped error when messages had arrived, with what the mirror gained", async () => {
    await t.serve(backfillResponse({ add: older(1), failed: "websocket closed" }))
    expect(await t.run({ chat: CHAT })).toMatchObject({ added: 1, held: 3, stopped: "error", service_running: true })
    await startedAgain()
  })

  test("is upstream_error with wacli's text when nothing arrived, never uncertain: the outcome is known", async () => {
    await t.serve(backfillResponse({ failed: "usync query failed" }))
    const error = await t.failure({ chat: CHAT })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("usync query failed")
    await startedAgain()
  })

  test("keeps the code of an error wacli's text names, such as a session that is gone", async () => {
    await t.serve(backfillResponse({ failed: "not authenticated; run `wacli auth`" }))
    expect((await t.failure({ chat: CHAT })).code).toBe("unauthenticated")
    await startedAgain()
  })

  test("is upstream_error when wacli printed no result at all", async () => {
    await t.serve({ args: ["history", "backfill"], exit: 3 })
    const error = await t.failure({ chat: CHAT })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("without a result")
  })
})

describe("without the sync service", () => {
  test("is upstream_error saying to start it, and wacli is never asked", async () => {
    t.fixture.fake.setMirror(HELD_MIRROR)
    const error = await t.failure({ chat: CHAT })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("start it first")
    expect(await t.backfillCalls()).toEqual([])
  })
})
