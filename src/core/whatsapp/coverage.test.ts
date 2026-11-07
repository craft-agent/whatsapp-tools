import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { wacliChat, wacliMessage, at } from "../chat/read.testing"
import { readCoverage } from "./coverage"
import { resetWacliCache, runWacli } from "./wacli"
import { envelope, installFakeWacli, pathsIn, type FakeWacli } from "./wacli.testing"

const CHAT = "15550100001@s.whatsapp.net"
const EMPTY_CHAT = "15550100002@s.whatsapp.net"
const OTHER_CHAT = "120363000000000001@g.us"

let fake: FakeWacli

beforeEach(async () => {
  resetWacliCache()
  fake = await installFakeWacli()
  fake.setMirror({
    chats: [wacliChat({ jid: CHAT }), wacliChat({ jid: EMPTY_CHAT })],
    messages: [
      wacliMessage({ id: "m2", chat: CHAT, at: at(20) }),
      wacliMessage({ id: "m1", chat: CHAT, at: at(10) }),
      wacliMessage({ id: "g1", chat: OTHER_CHAT, at: at(1) }),
    ],
  })
})

afterEach(async () => {
  await fake.cleanup()
})

const read = (chat: string) => readCoverage(pathsIn(fake.dir), chat, { env: fake.env })

describe("readCoverage", () => {
  test("gives how many messages the mirror holds of the chat and the time of the oldest", async () => {
    expect(await read(CHAT)).toEqual({ held: 2, oldestMs: at(10) })
    expect(await read(OTHER_CHAT)).toEqual({ held: 1, oldestMs: at(1) })
  })

  test("gives no oldest time for a chat that holds no message, whatever time wacli prints", async () => {
    expect(await read(EMPTY_CHAT)).toEqual({ held: 0, oldestMs: null })
  })

  test("gives undefined for a chat the mirror does not know", async () => {
    expect(await read("15550100009@s.whatsapp.net")).toBeUndefined()
  })

  test("reads with --read-only for the chat, blocked rows included", async () => {
    await read(CHAT)
    const call = (await fake.calls()).find((candidate) => candidate.argv.includes("coverage"))
    expect(call?.argv).toEqual([
      "--store",
      pathsIn(fake.dir).store,
      "--json",
      "--read-only",
      "history",
      "coverage",
      "--chat",
      CHAT,
      "--include-blocked",
    ])
  })

  test("is upstream_error for an answer it cannot read", async () => {
    const unreadable = [
      { nope: 1 },
      { coverage: [{ chat_jid: CHAT, message_count: "2", oldest_ts: "x" }] },
      { coverage: [{ chat_jid: CHAT, message_count: 2, oldest_ts: "not a time" }] },
    ]
    for (const data of unreadable) {
      fake.setResponses([{ args: ["history", "coverage"], stdout: envelope(data) }])
      await expect(read(CHAT)).rejects.toMatchObject({ code: "upstream_error" })
    }
  })
})

describe("the fake's history coverage", () => {
  test("lists every chat without --chat, an empty one as blocked with wacli's zero time", async () => {
    const data = (await runWacli(pathsIn(fake.dir), ["history", "coverage"], { env: fake.env, mode: "read" })) as {
      coverage: Record<string, unknown>[]
    }
    expect(data.coverage.map((row) => [row.chat_jid, row.message_count, row.status])).toEqual([
      [CHAT, 2, "ready"],
      [EMPTY_CHAT, 0, "blocked"],
      [OTHER_CHAT, 1, "ready"],
    ])
    expect(data.coverage[1]).toMatchObject({ oldest_ts: "0001-01-01T00:00:00Z", blocked_reason: "no_local_anchor" })
  })

  test("sees the messages a response adds to the mirror", async () => {
    fake.setResponses([
      { args: ["history", "backfill"], addMessages: [wacliMessage({ id: "m0", chat: CHAT, at: at(3) })] },
    ])
    await runWacli(pathsIn(fake.dir), ["history", "backfill"], { env: fake.env, mode: "write" }).catch(() => {})
    expect(await read(CHAT)).toEqual({ held: 3, oldestMs: at(3) })
  })
})
