import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { TEAM, wacliChat } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { DOCTOR_OK } from "../../whatsapp/sync.testing"
import { envelope, failure } from "../../whatsapp/wacli.testing"
import {
  CHAT,
  MESSAGE_ID,
  THUMBS_UP,
  createReactTest,
  doctorLinkedTo,
  messageRow,
  type ReactTest,
} from "./react.testing"
import { whatsappMessageReact } from "./tool"
import { REACT_WORDS } from "./words"

let t: ReactTest

beforeEach(async () => {
  t = await createReactTest()
})

afterEach(async () => {
  await t.close()
})

const OWN = "15550100000@s.whatsapp.net"
const ARGS = { chat: TEAM, id: MESSAGE_ID, emoji: THUMBS_UP }

/** The group's mirror holding the user's own message, as wacli stores what it sent itself: with no sender. */
const OWN_GROUP_MIRROR = {
  chats: [wacliChat({ jid: TEAM, kind: "group", name: "Team" })],
  messages: [messageRow({ chat: TEAM, FromMe: true, SenderJID: "" })],
}

describe("a reaction to the user's own message in a group, which the mirror holds with no sender", () => {
  test("is sent with the account's own JID, without the device, as wacli reports it", async () => {
    await t.serve({ mirror: OWN_GROUP_MIRROR, doctor: doctorLinkedTo("15550100000:4@s.whatsapp.net") })
    const result = await t.run(ARGS)
    expect(await t.sender()).toBe(OWN)
    expect(JSON.stringify(result)).not.toContain("15550100000")
  })

  test("is sent the same way when the reaction is removed", async () => {
    await t.serve({ mirror: OWN_GROUP_MIRROR, doctor: doctorLinkedTo(OWN) })
    const result = await t.run({ chat: TEAM, id: MESSAGE_ID, remove: true })
    expect(result.emoji).toBeNull()
    expect(await t.sender()).toBe(OWN)
  })

  test.each([
    ["no linked_jid", DOCTOR_OK],
    ["a linked_jid that is no JID", doctorLinkedTo("not a jid")],
    ["a doctor that fails", { args: ["doctor"], stderr: failure("store is locked"), exit: 1 }],
    ["a doctor report that is no object", { args: ["doctor"], stdout: envelope(["x"]) }],
  ])("is upstream_error, with nothing sent, when wacli gives %s", async (_what, doctor) => {
    // The service needs a usable doctor to start; the one under test is set once it is up.
    await t.serve({ mirror: OWN_GROUP_MIRROR })
    t.setUp({ mirror: OWN_GROUP_MIRROR, doctor })
    const error = await t.failure(ARGS)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("did not say which account this label is linked to")
    expect(error.message).toContain("Nothing was changed")
    expect(error.message).not.toMatch(/\d{5}/)
    expect(await t.reactCalls()).toEqual([])
  })

  test("is described without asking for the account, as the user's own message", async () => {
    await t.serve({ mirror: OWN_GROUP_MIRROR })
    const description = await callDescription(whatsappMessageReact, ARGS, {
      cwd: t.fixture.stateDir,
      stateDir: t.fixture.stateDir,
    })
    expect(description?.facts[1]).toEqual({ label: REACT_WORDS.fromLabel, value: { text: REACT_WORDS.fromMe } })
    expect(await t.reactCalls()).toEqual([])
  })

  test("is not given the account's JID in a person's chat, where no sender is needed", async () => {
    const own = messageRow({ FromMe: true, SenderJID: "" })
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT })], messages: [own] }, doctor: doctorLinkedTo(OWN) })
    await t.run({ chat: CHAT, id: MESSAGE_ID, emoji: THUMBS_UP })
    expect(await t.sender()).toBeUndefined()
  })
})
