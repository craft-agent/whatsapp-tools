import { mkdirSync } from "node:fs"
import { ALICE, BOB, wacliChat, wacliMessage } from "../../chat/read.testing"
import { ToolError } from "../../errors"
import { MS_PER_MINUTE } from "../../time"
import { invoke } from "../../tool"
import { serviceOperations } from "../../whatsapp/operations"
import type { ServiceOperations } from "../../whatsapp/service-socket"
import {
  DOCTOR_OK,
  HANGING_SYNC,
  eventually,
  startService,
  syncFixture,
  type SyncFixture,
} from "../../whatsapp/sync.testing"
import { resetWacliCache } from "../../whatsapp/wacli"
import { envelope, type FakeCall, type FakeMirror, type FakeResponse } from "../../whatsapp/wacli.testing"
import type { MessageReactOutput } from "./schema"
import { whatsappMessageReact } from "./tool"

/** The chat the tests react in, and the id of the message they react to. */
export const CHAT = ALICE
export const MESSAGE_ID = "3EB0A1B2C3D4E5F6"

/** The emoji the tests react with. */
export const THUMBS_UP = "\u{1F44D}"

/** A time `ms` before now. */
export const ago = (ms: number) => Date.now() - ms

/** A message of the chat, sent a minute ago and written by the other person; `change` replaces fields of the row. */
export function messageRow(change: Record<string, unknown> = {}): Record<string, unknown> {
  return wacliMessage({ id: MESSAGE_ID, chat: CHAT, at: ago(MS_PER_MINUTE), Text: "See you at 6", ...change })
}

/** The mirror a test starts with: the chat and the other person's message in it. */
export const HELD_MIRROR: FakeMirror = { chats: [wacliChat({ jid: CHAT })], messages: [messageRow()] }

/** What wacli prints for a reaction it sent. */
export const REACTED: Omit<FakeResponse, "args"> = {
  stdout: envelope({ sent: true, to: CHAT, id: "3EB0FFFFFFFFFFFF", target: MESSAGE_ID, reaction: THUMBS_UP }),
}

/** The author of the messages in the group the tests use, as the mirror holds it. */
export const AUTHOR = BOB

/** What a test sets up: the mirror, and the answer to `send react`. */
export type ReactSetup = { mirror?: FakeMirror; react?: Omit<FakeResponse, "args"> }

/** One tool call's surroundings: a label `main` with a fake wacli on `PATH`, the sync service and the tool. */
export type ReactTest = {
  fixture: SyncFixture
  /** Sets what the fake answers: the `mirror` (the chat and the other person's message by default) and the `react`. */
  setUp(setup?: ReactSetup): void
  /** Starts the sync service, with the operations of the CLI unless `operations` replaces them, and sets up the fake. */
  serve(setup?: ReactSetup & { operations?: ServiceOperations }): Promise<void>
  /** Runs the tool and returns its result. */
  run(args: unknown): Promise<MessageReactOutput>
  /** Runs the tool and returns the error it throws; `signal` cancels the call. */
  failure(args: unknown, signal?: AbortSignal): Promise<ToolError>
  /** The fake's calls of `send react`. */
  reactCalls(): Promise<FakeCall[]>
  /** The value of `--sender` of the one reaction the fake got, or undefined when it got none. */
  sender(): Promise<string | undefined>
  /** Waits until the fake has got a `send react`. */
  reactedOnce(): Promise<void>
  /** Every call the fake got besides the service's own (the version, `doctor` and `sync`). */
  wacliCalls(): Promise<FakeCall[]>
  close(): Promise<void>
}

const SERVICE_OWN = ["version", "doctor", "sync"]

/** Sets up a reaction test; call `close` afterwards. */
export async function createReactTest(): Promise<ReactTest> {
  resetWacliCache()
  const fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  const originalPath = process.env.PATH
  process.env.PATH = fixture.fake.env.PATH
  let service: Awaited<ReturnType<typeof startService>> | undefined

  const setUp: ReactTest["setUp"] = ({ mirror = HELD_MIRROR, react = REACTED } = {}) => {
    fixture.fake.setMirror(mirror)
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["send", "react"], ...react }])
  }
  const reactCalls: ReactTest["reactCalls"] = async () =>
    (await fixture.fake.calls()).filter((call) => call.argv.includes("react"))
  const call = (args: unknown, signal?: AbortSignal) =>
    invoke(whatsappMessageReact, args, { cwd: fixture.stateDir, stateDir: fixture.stateDir, signal })
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
    reactCalls,
    async sender() {
      const [react] = await reactCalls()
      const at = react?.argv.indexOf("--sender") ?? -1
      return at < 0 ? undefined : react?.argv[at + 1]
    },
    reactedOnce: () => eventually(async () => (await reactCalls()).length > 0),
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
