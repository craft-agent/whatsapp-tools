import { mkdirSync } from "node:fs"
import { ALICE, at, wacliChat, wacliMessage } from "../chat/read.testing"
import { ToolError } from "../errors"
import { invoke } from "../tool"
import type { BackfillLimits } from "../whatsapp/backfill"
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
import {
  envelope,
  eventLine,
  failure,
  type FakeCall,
  type FakeMirror,
  type FakeResponse,
} from "../whatsapp/wacli.testing"
import { whatsappHistoryBackfill } from "./backfill"
import type { HistoryBackfillOutput } from "./schema"

/** The chat the tests ask about: the mirror holds two messages of it, from the 100th and the 101st second. */
export const CHAT = ALICE

/** The mirror a test starts with: the chat and its two messages. */
export const HELD_MIRROR: FakeMirror = {
  chats: [wacliChat({ jid: CHAT })],
  messages: [wacliMessage({ id: "m1", chat: CHAT, at: at(100) }), wacliMessage({ id: "m2", chat: CHAT, at: at(101) })],
}

/** `count` messages older than the held ones, the oldest from the 5th second. */
export function older(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => wacliMessage({ id: `old${index}`, chat: CHAT, at: at(5 + index) }))
}

/** What a scripted `wacli history backfill` does. */
export type BackfillScript = {
  /** How many `backfill_response` events it reports; one by default. */
  responses?: number
  /** The reason of the `backfill_stopped` event it ends with, when it reports one. */
  reason?: string
  /** The messages it stores in the mirror. */
  add?: Record<string, unknown>[]
  /** The error it ends with, as wacli's failure envelope; it succeeds without one. */
  failed?: string
  /** What else the response does. */
  also?: Partial<FakeResponse>
}

/** The fake's answer to `history backfill` as the script says, with the events wacli reports on its standard error. */
export function backfillResponse({ responses = 1, reason, add, failed, also }: BackfillScript = {}): FakeResponse {
  const answers = Array.from({ length: responses }, (_, index) => ({
    line: eventLine("backfill_response", { chat_jid: CHAT, conversations: 1, messages: 50, responses_seen: index + 1 }),
  }))
  const stopped = reason ? [{ line: eventLine("backfill_stopped", { chat_jid: CHAT, reason }) }] : []
  const ending: Partial<FakeResponse> =
    failed === undefined
      ? {
          stdout: envelope({
            chat: CHAT,
            requests_sent: responses,
            responses_seen: responses,
            messages_added: 99,
            messages_synced: 99,
          }),
        }
      : { stderr: failure(failed), exit: 1 }
  return { args: ["history", "backfill"], stderrLines: [...answers, ...stopped], addMessages: add, ...ending, ...also }
}

/** One tool call's surroundings: a label `main` with a fake wacli on `PATH`, the sync service and the tool. */
export type BackfillTest = {
  fixture: SyncFixture
  /**
   * Starts the service, with `script` as the answer to `history backfill`, over `mirror` (the chat and two messages
   * by default). `operations` replaces the service's own operations.
   */
  serve(
    script?: FakeResponse,
    options?: { mirror?: FakeMirror; limits?: BackfillLimits; operations?: ServiceOperations },
  ): Promise<ReturnType<SyncFixture["start"]>>
  /** Runs the tool and returns its result. */
  run(args: unknown): Promise<HistoryBackfillOutput>
  /** Runs the tool and returns the error it throws. */
  failure(args: unknown): Promise<ToolError>
  /** The fake's calls of `history backfill`. */
  backfillCalls(): Promise<FakeCall[]>
  /** Waits until the sync child has been started `total` times in all and is running. */
  childBack(total: number): Promise<void>
  close(): Promise<void>
}

/** Sets up a backfill test; call `close` afterwards. */
export async function createBackfillTest(): Promise<BackfillTest> {
  resetWacliCache()
  const fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  const originalPath = process.env.PATH
  process.env.PATH = fixture.fake.env.PATH
  let service: Awaited<ReturnType<BackfillTest["serve"]>> | undefined

  const run: BackfillTest["run"] = (args) =>
    invoke(whatsappHistoryBackfill, args, { cwd: fixture.stateDir, stateDir: fixture.stateDir })
  return {
    fixture,
    async serve(script, { mirror = HELD_MIRROR, limits, operations = serviceOperations({ backfill: limits }) } = {}) {
      service = await startService(fixture, operations)
      fixture.fake.setMirror(mirror)
      fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, ...(script ? [script] : [])])
      return service
    },
    run,
    async failure(args) {
      try {
        await run(args)
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("expected the call to fail")
    },
    async backfillCalls() {
      return (await fixture.fake.calls()).filter((call) => call.argv.includes("backfill"))
    },
    childBack: (total) =>
      eventually(async () => (await fixture.syncCalls()).length === total && fixture.status()?.state === "running"),
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
