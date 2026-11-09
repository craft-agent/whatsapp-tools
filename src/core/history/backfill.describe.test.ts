import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, at, wacliChat, wacliMessage } from "../chat/read.testing"
import { callDescription } from "../describe"
import { BACKFILL_BATCHES } from "../whatsapp/backfill"
import { translator } from "../words"
import { whatsappHistoryBackfill } from "./backfill"
import { HELD_MIRROR, backfillResponse, createBackfillTest, type BackfillTest } from "./backfill.testing"
import { HISTORY_TRANSLATIONS, HISTORY_WORDS } from "./words"

let t: BackfillTest

beforeEach(async () => {
  t = await createBackfillTest()
})

afterEach(async () => {
  await t.close()
})

const describeCall = (args: Record<string, unknown>) =>
  callDescription(whatsappHistoryBackfill, args, { cwd: t.fixture.stateDir, stateDir: t.fixture.stateDir })

/** A time as the prompt writes it, built from the local calendar fields of the instant. */
function minuteOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

const NAMED_MIRROR = {
  chats: [wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: BOB, name: "  " })],
  messages: [
    wacliMessage({ id: "m1", chat: ALICE, at: at(100) }),
    wacliMessage({ id: "m2", chat: ALICE, at: at(101) }),
    wacliMessage({ id: "b1", chat: BOB, at: at(200) }),
  ],
}

describe("the description of a history backfill", () => {
  beforeEach(() => t.serve(backfillResponse(), { mirror: NAMED_MIRROR }))

  test("tells the chat, the pause, the default batches and the oldest held message", async () => {
    expect(await describeCall({ chat: ALICE })).toEqual({
      headline: { text: HISTORY_WORDS.headline, values: { chat: "Alice" } },
      facts: [
        { label: HISTORY_WORDS.syncLabel, value: { text: HISTORY_WORDS.syncPause, values: { minutes: 5 } } },
        { label: HISTORY_WORDS.batchesLabel, value: String(BACKFILL_BATCHES.default) },
        { label: HISTORY_WORDS.oldestLabel, value: minuteOf(at(100)) },
      ],
    })
  })

  test("tells the batches asked for", async () => {
    const description = await describeCall({ chat: ALICE, batches: 3 })
    expect(description?.facts[1]).toEqual({ label: HISTORY_WORDS.batchesLabel, value: "3" })
  })

  test("names a person with no mirror name by the number", async () => {
    expect((await describeCall({ chat: BOB }))?.headline?.values).toEqual({ chat: "+15550100002" })
  })

  test.each([
    ["a chat not in the mirror", { chat: "15550100009@s.whatsapp.net" }],
    ["a name instead of a JID", { chat: "Alice" }],
  ])("gives no description for %s", async (_what, args) => {
    expect(await describeCall(args)).toBeUndefined()
  })

  test("stays the same when a newer message arrives", async () => {
    const before = await describeCall({ chat: ALICE })
    t.fixture.fake.setMirror({
      ...NAMED_MIRROR,
      messages: [...NAMED_MIRROR.messages, wacliMessage({ id: "m3", chat: ALICE, at: at(300) })],
    })
    expect(await describeCall({ chat: ALICE })).toEqual(before)
  })

  test("only reads: every wacli call carries --read-only and no backfill is asked", async () => {
    await describeCall({ chat: ALICE })
    const calls = await t.fixture.fake.calls()
    const reads = calls.filter((call) => call.argv.includes("--store") && !call.argv.includes("sync"))
    expect(reads.length).toBeGreaterThan(0)
    for (const call of reads) expect(call.argv).toContain("--read-only")
    expect(await t.backfillCalls()).toEqual([])
  })

  test("has a Japanese headline and pause", async () => {
    const description = await describeCall({ chat: ALICE })
    const words = translator(HISTORY_TRANSLATIONS, "ja")
    expect(words.template(description!.headline!.text)).toBe(
      "{chat} の古いメッセージをスマートフォンに求めようとしています",
    )
    const pause = description!.facts[0]!.value
    expect(words.template(typeof pause === "string" ? pause : pause.text)).toBe("最大 {minutes} 分間一時停止")
  })
})

describe("the description of a chat with no message", () => {
  test("gives none", async () => {
    await t.serve(backfillResponse(), { mirror: { ...HELD_MIRROR, messages: [] } })
    expect(await describeCall({ chat: ALICE })).toBeUndefined()
  })
})
