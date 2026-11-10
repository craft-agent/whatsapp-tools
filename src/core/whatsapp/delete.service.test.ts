import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { ToolError, type ErrorCode } from "../errors"
import { MESSAGE_DELETE_DEADLINE_MS, MESSAGE_DELETE_OP, deleteAnswer } from "./delete"
import { serviceOperations } from "./operations"
import { callService } from "./service-client"
import type { ServiceOperations } from "./service-socket"
import { DOCTOR_OK, HANGING_SYNC, eventually, startService, syncFixture, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope, failure, type FakeResponse } from "./wacli.testing"

const CHAT = "15550100001@s.whatsapp.net"
const ID = "3EB0A1B2C3D4E5F6"

let fixture: SyncFixture
let service: Awaited<ReturnType<typeof startService>> | undefined

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
})

afterEach(async () => {
  service?.stop()
  await service?.outcome
  service = undefined
  await fixture.cleanup()
})

/** Starts the service with `operations` and has the fake answer the deletion as `response` says. */
async function serve(
  response: Omit<FakeResponse, "args"> = { stdout: revokedEnvelope() },
  operations = serviceOperations(),
) {
  service = await startService(fixture, operations)
  fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["messages", "delete"], ...response }])
}

const revokedEnvelope = (data: Record<string, unknown> = {}) =>
  envelope({ revoked: true, to: CHAT, id: "3EB0FFFFFFFFFFFF", target: ID, ...data })

const ask = (args: unknown = { chat: CHAT, id: ID }, timeoutMs = MESSAGE_DELETE_DEADLINE_MS) =>
  callService(fixture.paths, MESSAGE_DELETE_OP, args, { mode: "write", timeoutMs }).catch((error: unknown) => {
    if (error instanceof ToolError) return error
    throw error
  })

const deleteCalls = async () => (await fixture.fake.calls()).filter((call) => call.argv.includes("delete"))

/** Waits until the sync child has been started `total` times in all and is running. */
const childBack = (total: number) =>
  eventually(async () => (await fixture.syncCalls()).length === total && fixture.status()?.state === "running")

describe("the message_delete operation", () => {
  test("is an exclusive one that writes, so that the service runs it with its child stopped", async () => {
    await serve()
    expect(serviceOperations()[MESSAGE_DELETE_OP]).toMatchObject({ kind: "exclusive", writes: true })
  })

  test("answers with when it was accepted and that the service syncs again", async () => {
    await serve()
    const before = Date.now()
    const answer = deleteAnswer.parse(await ask())
    expect(answer.accepted_ms).toBeGreaterThanOrEqual(before)
    expect(answer.accepted_ms).toBeLessThanOrEqual(Date.now())
    expect(answer.service_running).toBe(true)
    expect(answer).not.toHaveProperty("store_warning")
  })

  test("is still a success when WhatsApp took the deletion and wacli could not write it to the mirror", async () => {
    await serve({ stderr: failure("store deleted message state: disk full for 15550100001"), exit: 1 })
    expect(await ask()).toMatchObject({
      store_warning: "store deleted message state: disk full for <number>",
      service_running: true,
    })
  })

  test("runs wacli for everyone, without --read-only and --for-me, with its own time-out", async () => {
    await serve()
    await ask()
    const [call, ...others] = await deleteCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual([
      "--store",
      fixture.paths.store,
      "--json",
      "messages",
      "delete",
      "--timeout",
      "60s",
      "--chat",
      CHAT,
      "--id",
      ID,
    ])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test("runs wacli with the sync child stopped, and starts the child again after it", async () => {
    const operation = serviceOperations()[MESSAGE_DELETE_OP]!
    if (operation.kind !== "exclusive") throw new Error("expected an exclusive operation")
    const seen: { stopped: number; wacliCalls: number; state: string | undefined }[] = []
    const watching: ServiceOperations = {
      [MESSAGE_DELETE_OP]: {
        ...operation,
        async run(args, context) {
          const stopped = fixture.logs.filter((line) => line === "event stopping").length
          seen.push({ stopped, wacliCalls: (await deleteCalls()).length, state: fixture.status()?.state })
          return operation.run(args, context)
        },
      },
    }
    await serve(undefined, watching)
    await ask()
    expect(seen).toEqual([{ stopped: 1, wacliCalls: 0, state: "paused" }])
    await childBack(2)
    expect(await fixture.syncCalls()).toHaveLength(2)
  })

  test("starts the child again when wacli fails, too", async () => {
    await serve({ stderr: failure(`message ${ID} was not sent by me`), exit: 1 })
    expect(((await ask()) as ToolError).code).toBe("forbidden")
    await childBack(2)
  })

  test.each([
    ["a chat that is not a JID", { chat: "Alice" }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["a broadcast list", { chat: "1555010000199@broadcast" }],
    ["a missing chat", { chat: undefined }],
    ["an id that is not a message id", { id: "-x" }],
    ["a missing id", { id: undefined }],
    ["a flag of wacli", { forMe: true }],
    ["an argument it does not know", { preview: true }],
  ])("refuses %s as invalid_argument, runs nothing and starts the child again", async (_what, change) => {
    await serve()
    const error = await ask({ chat: CHAT, id: ID, ...change })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await deleteCalls()).toEqual([])
    await childBack(2)
  })

  test("is uncertain when the deadline passes while wacli has not answered, wacli is stopped and the child starts again", async () => {
    await serve({ hang: true })
    const error = await ask(undefined, 3000)
    expect((error as ToolError).code).toBe("uncertain")
    expect(await deleteCalls()).toHaveLength(1)
    await childBack(2)
  })
})

describe("what wacli says when the deletion fails", () => {
  const fails = (text: string) => serve({ stderr: failure(text), exit: 1 })
  const asked = () => ask() as Promise<ToolError>

  test.each<[string, ErrorCode]>([
    [`message ${ID} was not sent by me`, "forbidden"],
    [`message ${ID} is already deleted`, "not_found"],
    [`message ${ID} was deleted for me`, "not_found"],
    ["--chat and --id are required", "invalid_argument"],
    ["sql: no rows in result set", "not_found"],
    ["read-only mode: delete is refused", "invalid_argument"],
    ["not authenticated; run `wacli auth`", "unauthenticated"],
    ["store is locked (another wacli is running?): locked", "upstream_error"],
  ])("%s is %s, and nothing was deleted", async (text, code) => {
    await fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain("15550100001")
  })

  test("says nothing was deleted for what it maps itself", async () => {
    await fails(`message ${ID} was not sent by me`)
    expect((await asked()).message).toBe(
      "Only the user's own messages can be deleted for everyone. Nothing was deleted.",
    )
  })

  test.each([
    ["send timed out after 45s"],
    ["delegated delete failed after dispatch and may still have gone through; check before retrying: deadline"],
    [`message ${ID} was not sent by me, though it may still have gone through`],
    ["connection lost; reconnect failed: dial tcp: i/o timeout"],
    [`wacli says message ${ID} was not sent by me later in its text`],
    ["send failed, then sql: no rows in result set"],
    ["something wacli has never said"],
    [""],
  ])("%p is uncertain", async (text) => {
    await fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
    await childBack(2)
  })

  test("is uncertain when wacli exits 1 without a result, or ends with output that is no result", async () => {
    await serve({ stderr: "panic: runtime error\n", exit: 1 })
    expect((await asked()).code).toBe("uncertain")
    fixture.fake.setResponses([
      DOCTOR_OK,
      HANGING_SYNC,
      { args: ["messages", "delete"], stdout: "not json\n", exit: 2 },
    ])
    await childBack(2)
    expect((await asked()).code).toBe("uncertain")
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["messages", "delete"], stdout: "Deleted\n" }])
    await childBack(3)
    expect((await asked()).code).toBe("uncertain")
  })

  test.each([
    ["revoked: false", { revoked: false, to: CHAT, id: ID }],
    ["no revoked", { to: CHAT, id: ID }],
    ["no data", null],
  ])("is uncertain when wacli reports success with %s", async (_what, data) => {
    await serve({ stdout: envelope(data) })
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })
})
