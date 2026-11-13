import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gateRefusal } from "../entry/gate"
import { ToolError } from "./errors"
import { createSendTest, type SendTest } from "./message/send.testing"
import { invoke, type ToolContext, type ToolSpec } from "./tool"
import { ARGUMENTS, GROUP, HIDDEN, MESSAGE_ID, PERSON, SENDS, chatTools } from "./tools.excluded.testing"

let t: SendTest
let work: string

beforeEach(async () => {
  t = await createSendTest()
  t.setUp({ mirror: { chats: [], messages: [] } })
  work = await mkdtemp(join(tmpdir(), "excluded-parity-"))
  await writeFile(join(work, "note.txt"), "hello")
})

afterEach(async () => {
  await t.close()
  await rm(work, { recursive: true, force: true })
})

/** The context of a call over the fake mirror, which holds none of the chats; `excluded` is the setting. */
function callContext(excluded: string[] = []): ToolContext {
  return {
    cwd: work,
    stateDir: t.fixture.stateDir,
    downloadDir: join(work, "downloads"),
    options: { exclude_chats: excluded },
  }
}

/** The code and message of the error `run` throws. */
async function failureOf(run: () => unknown): Promise<{ code: string; message: string }> {
  try {
    await run()
  } catch (error) {
    if (error instanceof ToolError) return { code: error.code, message: error.message }
    throw error
  }
  throw new Error("expected the call to fail")
}

/** What the gate refuses an excluded `chat` with. */
async function gateOf(spec: ToolSpec, args: unknown, chat: string) {
  const refusal = await gateRefusal(spec, args, callContext([chat]))
  if (!refusal) throw new Error("expected the gate to refuse")
  return { code: refusal.code, message: refusal.message }
}

describe("an excluded chat is refused as every harness refuses an unknown one", () => {
  for (const spec of chatTools.filter(({ id }) => id !== "whatsapp_chat_read")) {
    const cases: [string, Record<string, unknown>][] = [
      ["a group", { chat: GROUP }],
      ["a hidden-number contact", { chat: HIDDEN }],
    ]
    if (SENDS.includes(spec.id)) {
      cases.push(["a phone JID with reply_to", { chat: PERSON, reply_to: MESSAGE_ID }])
      // A phone JID without reply_to is the one difference by design: an unknown one is described as a new person and
      // WhatsApp is then asked about the number, while an excluded one is refused as WhatsApp giving no answer.
    } else {
      cases.push(["a phone JID", { chat: PERSON }])
    }

    for (const [name, extra] of cases) {
      test(`${spec.id}: ${name}`, async () => {
        const args = { ...ARGUMENTS[spec.id], ...extra }
        const chat = extra.chat as string
        const expected = await gateOf(spec, args, chat)

        // Where the entry points draw an approval prompt first (OpenCode, Hermes), the description fails first.
        if (spec.describe) {
          const describing = spec.describe.bind(spec)
          expect(await failureOf(() => describing(spec.input.parse(args), callContext()))).toEqual(expected)
        }
        // Where only the call runs (MCP clients).
        expect(await failureOf(() => invoke(spec, args, callContext()))).toEqual(expected)
        expect((await t.fixture.fake.calls()).filter((call) => call.argv.some((arg) => arg === "check"))).toEqual([])
      })
    }
  }

  test("chat_read, which has no description, gives the unknown-chat error from its call", async () => {
    const spec = chatTools.find(({ id }) => id === "whatsapp_chat_read")!
    expect(spec.describe).toBeUndefined()
    for (const chat of [GROUP, HIDDEN, PERSON]) {
      const args = { ...ARGUMENTS[spec.id], chat }
      expect(await failureOf(() => invoke(spec, args, callContext()))).toEqual(await gateOf(spec, args, chat))
    }
  })
})
