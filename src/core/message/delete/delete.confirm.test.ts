import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ALICE, BOB, wacliChat } from "../../chat/read.testing"
import { MS_PER_MINUTE } from "../../time"
import type { ConfirmRequest } from "../../tool"
import {
  MESSAGE_ID,
  MESSAGE_TEXT,
  ago,
  createDeleteTest,
  minuteOf,
  ownMessageRow,
  type DeleteTest,
} from "./delete.testing"

let t: DeleteTest

beforeEach(async () => {
  t = await createDeleteTest()
})

afterEach(async () => {
  await t.close()
})

const SENT_AT = ago(5 * MS_PER_MINUTE)

const ARGS = { chat: ALICE, id: MESSAGE_ID }

const NAMED_MIRROR = {
  chats: [wacliChat({ jid: ALICE, name: "Alice" })],
  messages: [ownMessageRow({ at: SENT_AT })],
}

/** A confirmation hook that answers `answer` and keeps the requests it got. */
function hook(answer: boolean) {
  const requests: ConfirmRequest[] = []
  return {
    requests,
    confirm: async (request: ConfirmRequest) => {
      requests.push(request)
      return answer
    },
  }
}

describe("the confirmation of a deletion", () => {
  test("is asked once, after the checks, in plain words with the chat's JID and the time sent", async () => {
    await t.serve({ mirror: NAMED_MIRROR })
    const { requests, confirm } = hook(true)
    expect(await t.run(ARGS, confirm)).toMatchObject({ id: MESSAGE_ID, deleted: true })
    expect(requests).toEqual([
      {
        tool: "whatsapp_message_delete",
        message: `Delete your message sent ${minuteOf(SENT_AT)} in chat ${ALICE} for everyone? Everyone in the chat sees it as deleted, and it cannot be undone.`,
      },
    ])
    expect(await t.deleteCalls()).toHaveLength(1)
  })

  test("never shows the chat's name or the message's text", async () => {
    const row = ownMessageRow({ chat: BOB, at: SENT_AT })
    await t.serve({ mirror: { chats: [wacliChat({ jid: BOB })], messages: [row] } })
    const { requests, confirm } = hook(true)
    await t.run({ chat: BOB, id: MESSAGE_ID }, confirm)
    expect(requests[0]!.message).toContain(`in chat ${BOB} for everyone`)
    expect(requests[0]!.message).not.toContain(MESSAGE_TEXT)
  })

  test("is declined when the person says no: nothing is deleted and the sync child is never stopped", async () => {
    await t.serve({ mirror: NAMED_MIRROR })
    const { requests, confirm } = hook(false)
    const error = await t.failure(ARGS, undefined, confirm)
    expect(error.code).toBe("declined")
    expect(requests).toHaveLength(1)
    expect(await t.deleteCalls()).toEqual([])
    expect(t.fixture.logs).not.toContain("event stopping")
    expect(await t.fixture.syncCalls()).toHaveLength(1)
  })

  test("is left to the harness's approval without a hook: the call goes through", async () => {
    await t.serve({ mirror: NAMED_MIRROR })
    expect(await t.run(ARGS)).toMatchObject({ id: MESSAGE_ID, deleted: true })
    expect(await t.deleteCalls()).toHaveLength(1)
  })

  test("is not asked for a call the tool refuses", async () => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: ALICE })], messages: [ownMessageRow({ FromMe: false })] } })
    const { requests, confirm } = hook(true)
    expect((await t.failure(ARGS, undefined, confirm)).code).toBe("forbidden")
    expect(requests).toEqual([])
  })
})
