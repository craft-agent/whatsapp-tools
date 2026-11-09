import { mkdirSync } from "node:fs"
import { ALICE, at, wacliChat, wacliMessage } from "../chat/read.testing"
import { ToolError } from "../errors"
import { invoke } from "../tool"
import { serviceOperations } from "../whatsapp/operations"
import type { ServiceOperations } from "../whatsapp/service-socket"
import {
  DOCTOR_OK,
  HANGING_SYNC,
  eventually,
  startService,
  syncFixture,
  type SyncFixture,
} from "../whatsapp/sync.testing"
import { resetWacliCache } from "../whatsapp/wacli"
import { envelope, type FakeCall, type FakeMirror, type FakeResponse } from "../whatsapp/wacli.testing"
import { whatsappMessageSend } from "./send"
import type { MessageSendOutput } from "./schema"

/** The chat the tests write to, and the id wacli gives the message they send. */
export const CHAT = ALICE
export const SENT_ID = "3EB0A1B2C3D4E5F6"

/** The id of a message of the chat that a reply quotes. */
export const REPLY_ID = "3EB0F6E5D4C3B2A1"

/** The mirror a test starts with: the chat and one message of it to reply to. */
export const HELD_MIRROR: FakeMirror = {
  chats: [wacliChat({ jid: CHAT })],
  messages: [wacliMessage({ id: REPLY_ID, chat: CHAT, at: at(1) })],
}

/** What wacli prints for a text it sent. */
export const SENT: Omit<FakeResponse, "args"> = {
  stdout: envelope({ sent: true, to: CHAT, id: SENT_ID }),
}

/** What a test sets up: the mirror, and the answer to `send text`. */
export type SendSetup = { mirror?: FakeMirror; send?: Omit<FakeResponse, "args"> }

/** One tool call's surroundings: a label `main` with a fake wacli on `PATH`, the sync service and the tool. */
export type SendTest = {
  fixture: SyncFixture
  /** Sets what the fake answers: the `mirror` (the chat and one message by default) and the `send`. */
  setUp(setup?: SendSetup): void
  /** Starts the sync service, with the operations of the CLI unless `operations` replaces them, and sets up the fake. */
  serve(setup?: SendSetup & { operations?: ServiceOperations }): Promise<void>
  /** Runs the tool and returns its result. */
  run(args: unknown): Promise<MessageSendOutput>
  /** Runs the tool and returns the error it throws; `signal` cancels the call. */
  failure(args: unknown, signal?: AbortSignal): Promise<ToolError>
  /** The fake's calls of `send text`. */
  sendCalls(): Promise<FakeCall[]>
  /** Waits until the fake has got a `send text`. */
  sentOnce(): Promise<void>
  /** Every call the fake got besides the service's own (the version, `doctor` and `sync`). */
  wacliCalls(): Promise<FakeCall[]>
  close(): Promise<void>
}

const SERVICE_OWN = ["version", "doctor", "sync"]

/** Sets up a send test; call `close` afterwards. */
export async function createSendTest(): Promise<SendTest> {
  resetWacliCache()
  const fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  const originalPath = process.env.PATH
  process.env.PATH = fixture.fake.env.PATH
  let service: Awaited<ReturnType<typeof startService>> | undefined

  const setUp: SendTest["setUp"] = ({ mirror = HELD_MIRROR, send = SENT } = {}) => {
    fixture.fake.setMirror(mirror)
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["send", "text"], ...send }])
  }
  const sendCalls: SendTest["sendCalls"] = async () =>
    (await fixture.fake.calls()).filter((call) => call.argv.includes("send"))
  const call = (args: unknown, signal?: AbortSignal) =>
    invoke(whatsappMessageSend, args, { cwd: fixture.stateDir, stateDir: fixture.stateDir, signal })
  return {
    fixture,
    setUp,
    async serve({ operations = serviceOperations(), ...setup } = {}) {
      service = await startService(fixture, operations)
      setUp(setup)
    },
    run: (args) => call(args),
    async failure(args, signal) {
      try {
        await call(args, signal)
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("expected the call to fail")
    },
    sendCalls,
    sentOnce: () => eventually(async () => (await sendCalls()).length > 0),
    async wacliCalls() {
      return (await fixture.fake.calls()).filter((call) => !SERVICE_OWN.some((name) => call.argv.includes(name)))
    },
    async close() {
      service?.stop()
      await service?.outcome
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      resetWacliCache()
      await fixture.cleanup()
    },
  }
}
