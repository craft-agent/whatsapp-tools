import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError, type ErrorCode } from "../../errors"
import { MESSAGE_EDIT_OP } from "../../whatsapp/edit"
import { failure } from "../../whatsapp/wacli.testing"
import { CHAT, MESSAGE_ID, createEditTest, type EditTest } from "./edit.testing"

let t: EditTest

beforeEach(async () => {
  t = await createEditTest()
})

afterEach(async () => {
  await t.close()
})

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/
const ARGS = { chat: CHAT, id: MESSAGE_ID, text: "See you at 7" }

describe("the result", () => {
  test("names the chat and the message, the time it was accepted in local time, and what accepted means", async () => {
    await t.serve()
    const before = Date.now()
    const result = await t.run({ ...ARGS, chat: "15550100001:7@s.whatsapp.net" })
    expect(result).toEqual({ chat: CHAT, id: MESSAGE_ID, time: expect.stringMatching(LOCAL_TIME), note: result.note })
    expect(Date.parse(result.time)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(result.time)).toBeLessThanOrEqual(Date.now())
    expect(result.note).toContain("not delivered or seen")
    expect(result.note).toContain("marked as edited")
    expect(result).not.toHaveProperty("errors")
    const [call] = await t.editCalls()
    expect(call!.argv.slice(call!.argv.indexOf("messages"))).toEqual([
      "messages",
      "edit",
      "--timeout",
      "60s",
      "--chat",
      CHAT,
      "--id",
      MESSAGE_ID,
      "--message",
      "See you at 7",
    ])
  })

  test("is still the result when wacli could not write the new text to the mirror, with errors.record saying why", async () => {
    await t.serve({ edit: { stderr: failure("store edited message text: disk full"), exit: 1 } })
    expect(await t.run(ARGS)).toMatchObject({
      id: MESSAGE_ID,
      errors: { record: "store edited message text: disk full" },
    })
  })
})

describe("an edit that ends in a failure", () => {
  test.each([
    ["edit timed out after 45s"],
    ["delegated edit failed after dispatch and may still have gone through; check before retrying: context canceled"],
  ])("%p is uncertain, telling to read the chat before editing again", async (text) => {
    await t.serve({ edit: { stderr: failure(text), exit: 1 } })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("The edit may have gone out")
    expect(error.message).toContain("whatsapp_chat_read")
    expect(error.message).toContain("never repeat it on your own")
  })

  test("is uncertain when the service stops answering, and wacli is not asked again", async () => {
    await t.serve({ edit: { hang: true } })
    const controller = new AbortController()
    const pending = t.failure(ARGS, controller.signal)
    await t.editedOnce()
    controller.abort()
    expect((await pending).code).toBe("uncertain")
    expect(await t.editCalls()).toHaveLength(1)
  })

  test("is uncertain when the service's answer cannot be read, since the edit may have gone out", async () => {
    await t.serve({
      operations: { [MESSAGE_EDIT_OP]: { kind: "delegated", writes: true, run: async () => ({ accepted_ms: "now" }) } },
    })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("never repeat it on your own")
  })

  test.each<[string, ErrorCode]>([
    [`message ${MESSAGE_ID} was not sent by me`, "forbidden"],
    [`message ${MESSAGE_ID} is already deleted`, "not_found"],
    ["only text messages can be edited", "invalid_argument"],
    [`message ${MESSAGE_ID} is older than WhatsApp's 15m0s edit window`, "forbidden"],
    ["request timed out in the send queue before dispatch; it was not sent", "upstream_error"],
  ])("keeps its code when wacli says %p", async (text, code) => {
    await t.serve({ edit: { stderr: failure(text), exit: 1 } })
    const error = await t.failure(ARGS)
    expect(error.code).toBe(code)
    expect(error.message).toContain("Nothing was")
  })

  test("is upstream_error without a running service, saying to start it, and nothing is edited", async () => {
    t.setUp()
    const error = await t.failure(ARGS)
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("is not running; start it first")
    expect(error.message).toContain("whatsapp_account_read")
    expect(await t.editCalls()).toEqual([])
  })

  test("is not_found for an account that is not paired, before anything runs", async () => {
    await t.serve()
    const error = await t.failure({ ...ARGS, account: "other" })
    expect(error.code).toBe("not_found")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("is the abort itself when the call is aborted before it reaches the service, and nothing is edited", async () => {
    await t.serve()
    const controller = new AbortController()
    controller.abort()
    const error = await t.failure(ARGS, controller.signal).catch((thrown: unknown) => thrown)
    expect(error).not.toBeInstanceOf(ToolError)
    expect(await t.editCalls()).toEqual([])
  })
})
