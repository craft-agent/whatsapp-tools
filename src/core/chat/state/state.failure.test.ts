import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError, type ErrorCode } from "../../errors"
import { CHAT_ARCHIVE_OP, CHAT_MUTE_OP, CHAT_PIN_OP } from "../../whatsapp/chat-state"
import { failure } from "../../whatsapp/wacli.testing"
import { ALICE } from "../read.testing"
import { whatsappChatArchive } from "./archive"
import { whatsappChatMute } from "./mute"
import { whatsappChatPin } from "./pin"
import { createStateTest, type StateTest } from "./state.testing"
import { UNCERTAIN_CHANGE } from "./state"

let t: StateTest

beforeEach(async () => {
  t = await createStateTest()
})

afterEach(async () => {
  await t.close()
})

const CALLS = [
  ["whatsapp_chat_archive", whatsappChatArchive, { archived: true }],
  ["whatsapp_chat_pin", whatsappChatPin, { pinned: false }],
  ["whatsapp_chat_mute", whatsappChatMute, { mute: "1_week" }],
] as const

describe.each(CALLS)("%s that ends in a failure", (_id, tool, change) => {
  const args = { chat: ALICE, ...change }

  test.each([
    ["delegated chat_state failed after dispatch and may still have gone through; check before retrying: deadline"],
    ["wait for missing WhatsApp app state key during regular_low recovery: context deadline exceeded"],
    ["connection lost; reconnect failed: dial tcp: i/o timeout"],
  ])("%p is uncertain, saying that calling again is safe", async (text) => {
    await t.serve({ change: { stderr: failure(text), exit: 1 } })
    const error = await t.failure(tool, args)
    expect(error.code).toBe("uncertain")
    expect(error.message).toBe(UNCERTAIN_CHANGE)
    expect(error.message).toContain("calling the tool again with the same arguments is safe")
  })

  test("is uncertain when the service stops answering, and wacli is not asked again", async () => {
    await t.serve({ change: { hang: true } })
    const controller = new AbortController()
    const pending = t.failure(tool, args, controller.signal)
    await t.changedOnce()
    controller.abort()
    expect((await pending).code).toBe("uncertain")
    expect(await t.changeCalls()).toHaveLength(1)
  })

  test("is uncertain when the service's answer cannot be read, since the change may have gone out", async () => {
    const run = async () => ({ accepted_ms: "now" })
    await t.serve({
      operations: {
        [CHAT_ARCHIVE_OP]: { kind: "delegated", writes: true, run },
        [CHAT_PIN_OP]: { kind: "delegated", writes: true, run },
        [CHAT_MUTE_OP]: { kind: "delegated", writes: true, run },
      },
    })
    const error = await t.failure(tool, args)
    expect(error.code).toBe("uncertain")
    expect(error.message).toBe(UNCERTAIN_CHANGE)
  })

  test.each<[string, ErrorCode]>([
    ["request deadline passed before dispatch; it was not sent", "upstream_error"],
    ["the running sync process does not support delegated chats archive; restart `wacli sync`", "upstream_error"],
  ])("keeps its code when wacli says %p, and says nothing was changed", async (text, code) => {
    await t.serve({ change: { stderr: failure(text), exit: 1 } })
    const error = await t.failure(tool, args)
    expect(error.code).toBe(code)
    expect(error.message).toContain("Nothing was changed")
  })

  test("keeps the code of a wacli that is not logged in", async () => {
    await t.serve({ change: { stderr: failure("not authenticated; run `wacli auth`"), exit: 1 } })
    expect((await t.failure(tool, args)).code).toBe("unauthenticated")
  })

  test("is upstream_error without a running service, saying to start it, and nothing is changed", async () => {
    t.setUp()
    const error = await t.failure(tool, args)
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("is not running; start it first")
    expect(error.message).toContain("whatsapp_account_read")
    expect(await t.changeCalls()).toEqual([])
  })

  test("is not_found for an account that is not paired, before anything runs", async () => {
    await t.serve()
    const error = await t.failure(tool, { ...args, account: "other" })
    expect(error.code).toBe("not_found")
    expect(await t.wacliCalls()).toEqual([])
  })

  test("is the abort itself when the call is aborted before it reaches the service, and nothing is changed", async () => {
    await t.serve()
    const controller = new AbortController()
    controller.abort()
    const error = await t.failure(tool, args, controller.signal).catch((thrown: unknown) => thrown)
    expect(error).not.toBeInstanceOf(ToolError)
    expect(await t.changeCalls()).toEqual([])
  })
})
