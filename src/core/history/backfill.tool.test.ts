import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeTargets } from "../targets"
import { annotations } from "../tool"
import { CHAT, HELD_MIRROR, backfillResponse, createBackfillTest, type BackfillTest } from "./backfill.testing"
import { whatsappHistoryBackfill } from "./backfill"

let t: BackfillTest

beforeEach(async () => {
  t = await createBackfillTest()
})

afterEach(async () => {
  await t.close()
})

describe("the tool's definition", () => {
  test("is an add in the history toolset, which writes the mirror only and sends nothing", () => {
    expect(whatsappHistoryBackfill.id).toBe("whatsapp_history_backfill")
    expect(whatsappHistoryBackfill.toolset).toBe("history")
    expect(whatsappHistoryBackfill.class).toBe("add")
    expect(annotations(whatsappHistoryBackfill)).toEqual({
      title: "Ask the phone for older messages",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
    const description = whatsappHistoryBackfill.description
    expect(description).toContain("sync service")
    expect(description).toContain("about five minutes")
    expect(description).toContain("sends nothing to anyone")
    expect(description).toContain("best effort")
  })

  test("describes every argument and every field of its result", () => {
    const undescribed = (shape: Record<string, { description?: string }>) =>
      Object.entries(shape)
        .filter(([, field]) => !field.description)
        .map(([name]) => name)
    expect(undescribed(whatsappHistoryBackfill.input.shape)).toEqual([])
    expect(undescribed(whatsappHistoryBackfill.output.shape)).toEqual([])
  })
})

describe("what the call writes to", () => {
  const targets = (args: unknown, ctx: { stateDir?: string } = { stateDir: t.fixture.stateDir }) =>
    writeTargets(whatsappHistoryBackfill, args, { cwd: t.fixture.stateDir, ...ctx })

  test("is the account and the chat", async () => {
    expect(await targets({ chat: CHAT })).toEqual([`main/${CHAT}`])
    expect(await targets({ chat: CHAT, account: "main", batches: 3 })).toEqual([`main/${CHAT}`])
  })

  test("names a person by the JID without the device suffix", async () => {
    expect(await targets({ chat: "15550100001:7@s.whatsapp.net" })).toEqual([`main/${CHAT}`])
  })

  test("is * when the chat is not a JID, the account is unknown or there is no state directory", async () => {
    expect(await targets({ chat: "Ann" })).toEqual(["*"])
    expect(await targets({ chat: CHAT, account: "other" })).toEqual(["*"])
    expect(await targets({ chat: CHAT }, {})).toEqual(["*"])
    expect(await targets({ chat: CHAT, batches: 0 })).toEqual(["*"])
  })
})

describe("arguments the tool refuses before it asks the service", () => {
  test.each([
    ["a name for a chat", { chat: "Ann" }],
    ["a number for a chat", { chat: "+15550100001" }],
    ["no chat", {}],
    ["0 batches", { chat: CHAT, batches: 0 }],
    ["6 batches", { chat: CHAT, batches: 6 }],
    ["batches that are not whole", { chat: CHAT, batches: 1.5 }],
    ["an argument it does not know", { chat: CHAT, count: 500 }],
  ])("refuses %s as invalid_argument", async (_name, args) => {
    await t.serve(backfillResponse())
    const error = await t.failure(args)
    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain("+15550100001")
    expect(await t.backfillCalls()).toEqual([])
    expect(t.fixture.logs).not.toContain("event stopping")
  })

  test("tells where to find a chat's JID", async () => {
    await t.serve(backfillResponse())
    expect((await t.failure({ chat: "Ann" })).message).toContain("Use whatsapp_chat_read list to find the chat's JID")
  })
})

describe("a chat that cannot be asked about", () => {
  test("is not_found when the mirror does not know it, and the service is not paused", async () => {
    await t.serve(backfillResponse(), { mirror: { chats: [], messages: [] } })
    const error = await t.failure({ chat: CHAT })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("whatsapp_chat_read list")
    expect(await t.backfillCalls()).toEqual([])
    expect(await t.fixture.syncCalls()).toHaveLength(1)
    expect(t.fixture.logs).not.toContain("event stopping")
  })

  test("is not_found when the mirror holds no message of it, saying history starts at pairing", async () => {
    await t.serve(backfillResponse(), { mirror: { ...HELD_MIRROR, messages: [] } })
    const error = await t.failure({ chat: CHAT })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("holds no message of this chat to ask from")
    expect(error.message).toContain("history starts at pairing")
    expect(await t.backfillCalls()).toEqual([])
    expect(await t.fixture.syncCalls()).toHaveLength(1)
    expect(t.fixture.logs).not.toContain("event stopping")
  })

  test("is not_found for an account that is not paired, before anything runs", async () => {
    await t.serve(backfillResponse())
    const error = await t.failure({ chat: CHAT, account: "other" })
    expect(error.code).toBe("not_found")
    expect(await t.backfillCalls()).toEqual([])
  })
})
