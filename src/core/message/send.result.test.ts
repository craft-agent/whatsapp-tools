import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { MESSAGE_SEND_OP } from "../whatsapp/send"
import { envelope, failure } from "../whatsapp/wacli.testing"
import { CHAT, SENT_ID, createSendTest, type SendTest } from "./send.testing"

let t: SendTest

beforeEach(async () => {
  t = await createSendTest()
})

afterEach(async () => {
  await t.close()
})

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/

describe("the result", () => {
  test("names the chat and the message, the time it was accepted in local time, and what accepted means", async () => {
    await t.serve()
    const before = Date.now()
    const result = await t.run({ chat: "15550100001:7@s.whatsapp.net", text: "hi" })
    expect(result).toEqual({ chat: CHAT, id: SENT_ID, time: expect.stringMatching(LOCAL_TIME), note: result.note })
    expect(Date.parse(result.time)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(result.time)).toBeLessThanOrEqual(Date.now())
    expect(result.note).toContain("not delivered or read")
    expect(result.note).toContain("the user's")
    expect(result).not.toHaveProperty("errors")
    const [call] = await t.sendCalls()
    expect(call!.argv[call!.argv.indexOf("--to") + 1]).toBe(CHAT)
  })

  test("is still the result when wacli could not write the message to the mirror, with errors.record saying why", async () => {
    await t.serve({
      send: { stdout: envelope({ sent: true, to: CHAT, id: SENT_ID, store_warning: "message update: disk full" }) },
    })
    expect(await t.run({ chat: CHAT, text: "hi" })).toMatchObject({
      id: SENT_ID,
      errors: { record: "message update: disk full" },
    })
  })
})

describe("a send that ends in a failure", () => {
  test.each([
    ["send timed out after 45s"],
    ["delegated text failed after dispatch and may still have gone through; check before retrying: context canceled"],
  ])("%p is uncertain, telling to read the chat and ask the user before sending again", async (text) => {
    await t.serve({ send: { stderr: failure(text), exit: 1 } })
    const error = await t.failure({ chat: CHAT, text: "hi" })
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("may have been sent")
    expect(error.message).toContain("whatsapp_chat_read")
    expect(error.message).toContain("ask the user before sending it again")
    expect(error.message).toContain("never send it again on your own")
  })

  test("is uncertain when the service stops answering, and wacli is not asked again", async () => {
    await t.serve({ send: { hang: true } })
    const controller = new AbortController()
    const pending = t.failure({ chat: CHAT, text: "hi" }, controller.signal)
    await t.sentOnce()
    controller.abort()
    expect((await pending).code).toBe("uncertain")
    expect(await t.sendCalls()).toHaveLength(1)
  })

  test("is uncertain when the service's answer cannot be read, since the message may have gone out", async () => {
    await t.serve({
      operations: { [MESSAGE_SEND_OP]: { kind: "delegated", writes: true, run: async () => ({ id: 5 }) } },
    })
    const error = await t.failure({ chat: CHAT, text: "hi" })
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("ask the user before sending it again")
  })

  test("keeps its code when wacli says nothing was sent", async () => {
    await t.serve({
      send: { stderr: failure("request timed out in the send queue before dispatch; it was not sent"), exit: 1 },
    })
    const error = await t.failure({ chat: CHAT, text: "hi" })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("Nothing was sent")
  })

  test("is upstream_error without a running service, saying to start it, and nothing is sent", async () => {
    t.setUp()
    const error = await t.failure({ chat: CHAT, text: "hi" })
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("is not running; start it first")
    expect(error.message).toContain("whatsapp_account_read")
    expect(error.message).toContain("Nothing was sent")
    expect(await t.sendCalls()).toEqual([])
  })

  test("is not_found for an account that is not paired, before anything runs", async () => {
    await t.serve()
    const error = await t.failure({ chat: CHAT, text: "hi", account: "other" })
    expect(error.code).toBe("not_found")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("is the abort itself when the call is aborted before it reaches the service, and nothing is sent", async () => {
    await t.serve()
    const controller = new AbortController()
    controller.abort()
    const error = await t.failure({ chat: CHAT, text: "hi" }, controller.signal).catch((thrown: unknown) => thrown)
    expect(error).not.toBeInstanceOf(ToolError)
    expect(await t.sendCalls()).toEqual([])
  })
})
