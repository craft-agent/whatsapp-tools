import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import { HISTORY_BACKFILL_OP } from "../whatsapp/backfill"
import { serviceOperations } from "../whatsapp/operations"
import { callService } from "../whatsapp/service-client"
import type { ServiceOperations } from "../whatsapp/service-socket"
import { eventually } from "../whatsapp/sync.testing"
import { CHAT, backfillResponse, createBackfillTest, older, type BackfillTest } from "./backfill.testing"

let t: BackfillTest

beforeEach(async () => {
  t = await createBackfillTest()
})

afterEach(async () => {
  await t.close()
})

/** Whether a process with this id is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("a service that stops during the backfill", () => {
  test("gives up on it as uncertain, does not start the child again and leaves no wacli behind", async () => {
    const { outcome, stop } = await t.serve(backfillResponse({ add: older(1), also: { hang: true } }))
    const pending = t.failure({ chat: CHAT })
    await eventually(async () => (await t.backfillCalls()).length === 1)
    stop()

    const error = await pending
    expect(error.code).toBe("uncertain")
    expect(await outcome).toEqual({ exitCode: 0, state: "stopped" })
    expect(await t.fixture.syncCalls()).toHaveLength(1)
    expect(t.fixture.leftovers()).toEqual([])
    const [call] = await t.backfillCalls()
    await eventually(() => !alive(call!.pid))
  })
})

describe("a service that cannot start its child again", () => {
  test("still answers with what the backfill did, saying that it does not sync", async () => {
    const operations = serviceOperations()
    const backfill = operations[HISTORY_BACKFILL_OP]!
    if (backfill.kind !== "exclusive") throw new Error("expected an exclusive operation")
    const withoutWacli: ServiceOperations = {
      [HISTORY_BACKFILL_OP]: {
        ...backfill,
        async run(args, context) {
          const result = await backfill.run(args, context)
          await rm(join(t.fixture.fake.dir, "wacli"))
          return result
        },
      },
    }
    const { outcome } = await t.serve(backfillResponse({ add: older(2) }), { operations: withoutWacli })
    expect(await t.run({ chat: CHAT })).toMatchObject({ added: 2, stopped: "batches_done", service_running: false })
    expect((await outcome).state).toBe("failed")
  })
})

describe("the operation asked directly", () => {
  const ask = (args: unknown) =>
    callService(t.fixture.paths, HISTORY_BACKFILL_OP, args, { mode: "write", timeoutMs: 20_000 }).catch(
      (error: unknown) => error as ToolError,
    )

  test.each([
    ["a chat that is not a JID", { chat: "Ann", batches: 2 }],
    ["a missing chat", { batches: 2 }],
    ["0 batches", { chat: CHAT, batches: 0 }],
    ["6 batches", { chat: CHAT, batches: 6 }],
    ["a missing number of batches", { chat: CHAT }],
    ["an argument it does not know", { chat: CHAT, batches: 2, count: 500 }],
  ])("refuses %s as invalid_argument and starts the child again", async (_name, args) => {
    await t.serve(backfillResponse())
    const error = await ask(args)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await t.backfillCalls()).toEqual([])
    await t.childBack(2)
  })

  test.each([
    ["a chat the mirror does not know", { chats: [], messages: [] }],
    ["a chat with no message", { chats: [{ jid: CHAT, kind: "dm", name: "" }], messages: [] }],
  ])("is not_found for %s, asks nothing of the phone and starts the child again", async (_name, mirror) => {
    await t.serve(backfillResponse(), { mirror })
    const error = await ask({ chat: CHAT, batches: 2 })
    expect((error as ToolError).code).toBe("not_found")
    expect(await t.backfillCalls()).toEqual([])
    await t.childBack(2)
  })
})
