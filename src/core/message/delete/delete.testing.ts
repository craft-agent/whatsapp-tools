import { mkdirSync } from "node:fs"
import { ALICE, wacliChat, wacliMessage } from "../../chat/read.testing"
import { ToolError } from "../../errors"
import { MS_PER_MINUTE } from "../../time"
import { invoke, type ToolContext } from "../../tool"
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
import type { MessageDeleteOutput } from "./schema"
import { whatsappMessageDelete } from "./tool"

/** The chat the tests delete in, and the id of the user's message they delete. */
export const CHAT = ALICE
export const MESSAGE_ID = "3EB0A1B2C3D4E5F6"

/** The text of that message. */
export const MESSAGE_TEXT = "Wrong chat, sorry"

/** A time `ms` before now, which keeps a message inside or outside the deletion window however long the test takes. */
export const ago = (ms: number) => Date.now() - ms

/** A time as the prompt writes it, built from the local calendar fields of the instant. */
export function minuteOf(ms: number): string {
  const d = new Date(Math.floor(ms / 1000) * 1000)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** The user's message the tests delete, sent a minute ago; `change` replaces fields of the row. */
export function ownMessageRow(change: Record<string, unknown> = {}): Record<string, unknown> {
  return wacliMessage({
    id: MESSAGE_ID,
    chat: CHAT,
    at: ago(MS_PER_MINUTE),
    FromMe: true,
    Text: MESSAGE_TEXT,
    ...change,
  })
}

/** The mirror a test starts with: the chat and the user's message in it. */
export const HELD_MIRROR: FakeMirror = { chats: [wacliChat({ jid: CHAT })], messages: [ownMessageRow()] }

/** What wacli prints for a deletion it made. */
export const REVOKED: Omit<FakeResponse, "args"> = {
  stdout: envelope({ revoked: true, to: CHAT, id: "3EB0FFFFFFFFFFFF", target: MESSAGE_ID }),
}

/** What a test sets up: the mirror, and the answer to `messages delete`. */
export type DeleteSetup = { mirror?: FakeMirror; revoke?: Omit<FakeResponse, "args"> }

/** One tool call's surroundings: a label `main` with a fake wacli on `PATH`, the sync service and the tool. */
export type DeleteTest = {
  fixture: SyncFixture
  /** Sets what the fake answers: the `mirror` (the chat and the user's message by default) and the `revoke`. */
  setUp(setup?: DeleteSetup): void
  /** Starts the sync service, with the operations of the CLI unless `operations` replaces them, and sets up the fake. */
  serve(setup?: DeleteSetup & { operations?: ServiceOperations }): Promise<ReturnType<SyncFixture["start"]>>
  /** Runs the tool and returns its result; `confirm` is the hook the entry point supplies with the `elicitation` setting. */
  run(args: unknown, confirm?: ToolContext["confirm"]): Promise<MessageDeleteOutput>
  /** Runs the tool and returns the error it throws; `signal` cancels the call. */
  failure(args: unknown, signal?: AbortSignal, confirm?: ToolContext["confirm"]): Promise<ToolError>
  /** The fake's calls of `messages delete`. */
  deleteCalls(): Promise<FakeCall[]>
  /** Waits until the fake has got a `messages delete`. */
  deletedOnce(): Promise<void>
  /** Waits until the sync child has been started `total` times in all and is running. */
  childBack(total: number): Promise<void>
  /** Every call the fake got besides the service's own (the version, `doctor` and `sync`). */
  wacliCalls(): Promise<FakeCall[]>
  close(): Promise<void>
}

const SERVICE_OWN = ["version", "doctor", "sync"]

/** Sets up a delete test; call `close` afterwards. */
export async function createDeleteTest(): Promise<DeleteTest> {
  resetWacliCache()
  const fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  const originalPath = process.env.PATH
  process.env.PATH = fixture.fake.env.PATH
  let service: Awaited<ReturnType<DeleteTest["serve"]>> | undefined

  const setUp: DeleteTest["setUp"] = ({ mirror = HELD_MIRROR, revoke = REVOKED } = {}) => {
    fixture.fake.setMirror(mirror)
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["messages", "delete"], ...revoke }])
  }
  const deleteCalls: DeleteTest["deleteCalls"] = async () =>
    (await fixture.fake.calls()).filter((call) => call.argv.includes("delete"))
  const call = (args: unknown, signal?: AbortSignal, confirm?: ToolContext["confirm"]) =>
    invoke(whatsappMessageDelete, args, { cwd: fixture.stateDir, stateDir: fixture.stateDir, signal, confirm })
  return {
    fixture,
    setUp,
    async serve({ operations = serviceOperations(), ...setup } = {}) {
      service = await startService(fixture, operations)
      setUp(setup)
      return service
    },
    run: (args, confirm) => call(args, undefined, confirm),
    async failure(args, signal, confirm) {
      try {
        await call(args, signal, confirm)
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("expected the call to fail")
    },
    deleteCalls,
    deletedOnce: () => eventually(async () => (await deleteCalls()).length > 0),
    childBack: (total) =>
      eventually(async () => (await fixture.syncCalls()).length === total && fixture.status()?.state === "running"),
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
