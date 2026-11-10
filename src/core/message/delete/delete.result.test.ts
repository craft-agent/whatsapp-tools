import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError, type ErrorCode } from "../../errors"
import { MESSAGE_DELETE_OP } from "../../whatsapp/delete"
import { serviceOperations } from "../../whatsapp/operations"
import type { ServiceOperations } from "../../whatsapp/service-socket"
import { envelope, failure } from "../../whatsapp/wacli.testing"
import { CHAT, MESSAGE_ID, createDeleteTest, type DeleteTest } from "./delete.testing"

let t: DeleteTest

beforeEach(async () => {
  t = await createDeleteTest()
})

afterEach(async () => {
  await t.close()
})

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/
const ARGS = { chat: CHAT, id: MESSAGE_ID }

describe("the result", () => {
  test("names the chat and the message, the time it was accepted in local time, that the service syncs again, and what accepted means", async () => {
    await t.serve()
    const before = Date.now()
    const result = await t.run({ ...ARGS, chat: "15550100001:7@s.whatsapp.net" })
    expect(result).toEqual({
      chat: CHAT,
      id: MESSAGE_ID,
      deleted: true,
      time: expect.stringMatching(LOCAL_TIME),
      service_running: true,
      note: result.note,
    })
    expect(Date.parse(result.time)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(result.time)).toBeLessThanOrEqual(Date.now())
    expect(result.note).toContain("not delivered")
    expect(result.note).toContain("nothing can bring it back")
    const [call] = await t.deleteCalls()
    expect(call!.argv.slice(call!.argv.indexOf("messages"))).toEqual([
      "messages",
      "delete",
      "--timeout",
      "60s",
      "--chat",
      CHAT,
      "--id",
      MESSAGE_ID,
    ])
  })

  test("pauses the sync for the call and starts it again", async () => {
    await t.serve()
    await t.run(ARGS)
    expect(t.fixture.logs.filter((line) => line === "event stopping")).toHaveLength(1)
    await t.childBack(2)
  })

  test("is still the result when wacli could not write the deletion to the mirror, with errors.record saying why", async () => {
    await t.serve({ revoke: { stderr: failure("store deleted message state: disk full"), exit: 1 } })
    expect(await t.run(ARGS)).toMatchObject({
      id: MESSAGE_ID,
      deleted: true,
      service_running: true,
      errors: { record: "store deleted message state: disk full" },
    })
  })

  test("says the service does not sync when it could not start its child again", async () => {
    const operation = serviceOperations()[MESSAGE_DELETE_OP]!
    if (operation.kind !== "exclusive") throw new Error("expected an exclusive operation")
    const withoutWacli: ServiceOperations = {
      [MESSAGE_DELETE_OP]: {
        ...operation,
        async run(args, context) {
          const result = await operation.run(args, context)
          await rm(join(t.fixture.fake.dir, "wacli"))
          return result
        },
      },
    }
    const { outcome } = await t.serve({ operations: withoutWacli })
    expect(await t.run(ARGS)).toMatchObject({ id: MESSAGE_ID, deleted: true, service_running: false })
    expect((await outcome).state).toBe("failed")
  })
})

describe("a deletion that ends in a failure", () => {
  test.each([
    ["send timed out after 45s"],
    ["delegated delete failed after dispatch and may still have gone through; check before retrying: context canceled"],
  ])("%p is uncertain, telling to read the chat before deleting again", async (text) => {
    await t.serve({ revoke: { stderr: failure(text), exit: 1 } })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("The deletion may have gone out")
    expect(error.message).toContain("whatsapp_chat_read")
    expect(error.message).toContain("never repeat it on your own")
    await t.childBack(2)
  })

  test("is uncertain when the service stops answering, and wacli is not asked again", async () => {
    await t.serve({ revoke: { hang: true } })
    const controller = new AbortController()
    const pending = t.failure(ARGS, controller.signal)
    await t.deletedOnce()
    controller.abort()
    expect((await pending).code).toBe("uncertain")
    expect(await t.deleteCalls()).toHaveLength(1)
  })

  test("is uncertain when the service's answer cannot be read, since the deletion may have gone out", async () => {
    await t.serve({
      operations: {
        [MESSAGE_DELETE_OP]: { kind: "exclusive", writes: true, run: async () => ({ accepted_ms: "now" }) },
      },
    })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("never repeat it on your own")
  })

  test("is uncertain when wacli says success without saying the message was revoked", async () => {
    await t.serve({ revoke: { stdout: envelope({ revoked: false }) } })
    expect((await t.failure(ARGS)).code).toBe("uncertain")
  })

  test.each<[string, ErrorCode]>([
    [`message ${MESSAGE_ID} was not sent by me`, "forbidden"],
    [`message ${MESSAGE_ID} is already deleted`, "not_found"],
    ["--chat and --id are required", "invalid_argument"],
  ])("keeps its code when wacli says %p", async (text, code) => {
    await t.serve({ revoke: { stderr: failure(text), exit: 1 } })
    const error = await t.failure(ARGS)
    expect(error.code).toBe(code)
    expect(error.message).toContain("Nothing was deleted")
    await t.childBack(2)
  })

  test("is upstream_error without a running service, saying to start it, and nothing is deleted", async () => {
    t.setUp()
    const error = await t.failure(ARGS)
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("is not running; start it first")
    expect(error.message).toContain("whatsapp_account_read")
    expect(await t.deleteCalls()).toEqual([])
  })

  test("is not_found for an account that is not paired, before anything runs", async () => {
    await t.serve()
    const error = await t.failure({ ...ARGS, account: "other" })
    expect(error.code).toBe("not_found")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("is the abort itself when the call is aborted before it reaches the service, and nothing is deleted", async () => {
    await t.serve()
    const controller = new AbortController()
    controller.abort()
    const error = await t.failure(ARGS, controller.signal).catch((thrown: unknown) => thrown)
    expect(error).not.toBeInstanceOf(ToolError)
    expect(await t.deleteCalls()).toEqual([])
  })
})
