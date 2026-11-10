import { mkdirSync } from "node:fs"
import { ALICE, wacliChat, wacliMessage } from "../../chat/read.testing"
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
import type { MessageEditOutput } from "./schema"
import { whatsappMessageEdit } from "./tool"

/** The chat the tests edit in, and the id of the user's message they edit. */
export const CHAT = ALICE
export const MESSAGE_ID = "3EB0A1B2C3D4E5F6"

/** The text of that message. */
export const CURRENT_TEXT = "See you at 6"

/** A time `ms` before now, which keeps a message inside or outside the edit window however long the test takes. */
export const ago = (ms: number) => Date.now() - ms

/** The user's message the tests edit, sent a minute ago; `change` replaces fields of the row. */
export function ownMessageRow(change: Record<string, unknown> = {}): Record<string, unknown> {
  return wacliMessage({
    id: MESSAGE_ID,
    chat: CHAT,
    at: ago(MS_PER_MINUTE),
    FromMe: true,
    Text: CURRENT_TEXT,
    ...change,
  })
}

/** The mirror a test starts with: the chat and the user's message in it. */
export const HELD_MIRROR: FakeMirror = { chats: [wacliChat({ jid: CHAT })], messages: [ownMessageRow()] }

/** What wacli prints for an edit it made. */
export const EDITED: Omit<FakeResponse, "args"> = {
  stdout: envelope({ edited: true, to: CHAT, id: MESSAGE_ID, target: MESSAGE_ID, message: "See you at 7" }),
}

/** What a test sets up: the mirror, and the answer to `messages edit`. */
export type EditSetup = { mirror?: FakeMirror; edit?: Omit<FakeResponse, "args"> }

/** One tool call's surroundings: a label `main` with a fake wacli on `PATH`, the sync service and the tool. */
export type EditTest = {
  fixture: SyncFixture
  /** Sets what the fake answers: the `mirror` (the chat and the user's message by default) and the `edit`. */
  setUp(setup?: EditSetup): void
  /** Starts the sync service, with the operations of the CLI unless `operations` replaces them, and sets up the fake. */
  serve(setup?: EditSetup & { operations?: ServiceOperations }): Promise<void>
  /** Runs the tool and returns its result. */
  run(args: unknown): Promise<MessageEditOutput>
  /** Runs the tool and returns the error it throws; `signal` cancels the call. */
  failure(args: unknown, signal?: AbortSignal): Promise<ToolError>
  /** The fake's calls of `messages edit`. */
  editCalls(): Promise<FakeCall[]>
  /** Waits until the fake has got a `messages edit`. */
  editedOnce(): Promise<void>
  /** Every call the fake got besides the service's own (the version, `doctor` and `sync`). */
  wacliCalls(): Promise<FakeCall[]>
  close(): Promise<void>
}

const SERVICE_OWN = ["version", "doctor", "sync"]

/** Sets up an edit test; call `close` afterwards. */
export async function createEditTest(): Promise<EditTest> {
  resetWacliCache()
  const fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  const originalPath = process.env.PATH
  process.env.PATH = fixture.fake.env.PATH
  let service: Awaited<ReturnType<typeof startService>> | undefined

  const setUp: EditTest["setUp"] = ({ mirror = HELD_MIRROR, edit = EDITED } = {}) => {
    fixture.fake.setMirror(mirror)
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["messages", "edit"], ...edit }])
  }
  const editCalls: EditTest["editCalls"] = async () =>
    (await fixture.fake.calls()).filter((call) => call.argv.includes("edit"))
  const call = (args: unknown, signal?: AbortSignal) =>
    invoke(whatsappMessageEdit, args, { cwd: fixture.stateDir, stateDir: fixture.stateDir, signal })
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
    editCalls,
    editedOnce: () => eventually(async () => (await editCalls()).length > 0),
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
