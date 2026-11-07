import { z } from "zod"
import { ToolError } from "../errors"
import type { LimitRule } from "../pages"
import { readCoverage } from "./coverage"
import type { ServiceOperation, ServiceOperationContext } from "./service-socket"
import { parseEvent } from "./sync-events"
import { execWacli, failureText, readEnvelope, wacliError } from "./wacli"

/** The name of the service operation that asks the phone for older messages of one chat. */
export const HISTORY_BACKFILL_OP = "history_backfill"

/** How many batches one call asks for: wacli sends one request to the phone for each. */
export const BACKFILL_BATCHES = { default: 2, max: 5 } as const satisfies LimitRule

/** How many older messages one batch asks for. */
export const BACKFILL_COUNT = 50

/** How long wacli waits for the phone's answer to one request. */
const BACKFILL_WAIT = "30s"

/** How long wacli stays connected without news from the phone before it ends. */
const BACKFILL_IDLE_EXIT = "5s"

/** How long wacli may run for a backfill: a request may wait several times `BACKFILL_WAIT` for its answer. */
export const BACKFILL_WACLI_LIMIT_MS = 260_000

/** How long a backfill may take in all, which is the deadline its caller gives the service. */
export const BACKFILL_DEADLINE_MS = 300_000

/** Why a backfill ended, as the operation reports it. */
export const BACKFILL_STOPPED = [
  "batches_done",
  "start_of_history",
  "nothing_older",
  "no_answer",
  "time_limit",
  "error",
] as const

/** One reason a backfill ended. */
export type BackfillStopped = (typeof BACKFILL_STOPPED)[number]

/** What `history_backfill` returns, besides the `service_running` the service adds. */
const backfillResult = z.object({
  chat: z.string(),
  /** How many messages of the chat the mirror gained. */
  added: z.number().int().nonnegative(),
  /** How many messages of the chat the mirror holds now. */
  held: z.number().int().nonnegative(),
  /** The time of the oldest message the mirror holds of the chat in milliseconds, or null when it holds none. */
  oldest_ms: z.number().nullable(),
  stopped: z.enum(BACKFILL_STOPPED),
  /** How many answers the phone gave. */
  responses: z.number().int().nonnegative(),
})

/** What a caller gets of `history_backfill`: the result with the `service_running` the service adds. */
export const backfillAnswer = backfillResult.extend({ service_running: z.boolean() })

type BackfillResult = z.infer<typeof backfillResult>

/** What a chat JID looks like: a name, `@` and a server. */
const CHAT_JID_FORM = /^[\w.-]+@[a-z.]+$/

/** The arguments of `history_backfill`. */
const backfillArguments = z.strictObject({
  chat: z.string().regex(CHAT_JID_FORM),
  batches: z.number().int().min(1).max(BACKFILL_BATCHES.max),
})

/** wacli's text when the phone gave no answer to a request, even after it tried again. */
const NO_ANSWER = /timed out waiting for on-demand history sync response/i

/** What the last `backfill_stopped` event of a successful run says, as the reason the operation reports. */
const STOPPED_BY_REASON: ReadonlyMap<string, BackfillStopped> = new Map<string, BackfillStopped>([
  ["start_of_history_reached", "start_of_history"],
  ["no_older_messages_added", "nothing_older"],
  ["no_messages_returned", "nothing_older"],
])

const PHONE_SILENT =
  "The phone did not answer the request for older messages, and nothing was added. Is the phone online with WhatsApp open? Asking again is safe."

/** What wacli reported on its standard error about the requests it made. */
type BackfillEvents = { responses: number; reason?: string }

/** Counts the answers (`backfill_response`) and finds the reason of the last `backfill_stopped` among wacli's events. */
function readEvents(stderr: string): BackfillEvents {
  const events: BackfillEvents = { responses: 0 }
  for (const line of stderr.split("\n")) {
    const event = parseEvent(line.trim())
    if (event?.name === "backfill_response") events.responses += 1
    if (event?.name === "backfill_stopped" && typeof event.data.reason === "string") events.reason = event.data.reason
  }
  return events
}

/** The `--events` global flag comes before the subcommand. */
function backfillArgs(chat: string, batches: number): string[] {
  return [
    "--events",
    "history",
    "backfill",
    "--chat",
    chat,
    "--count",
    String(BACKFILL_COUNT),
    "--requests",
    String(batches),
    "--wait",
    BACKFILL_WAIT,
    "--idle-exit",
    BACKFILL_IDLE_EXIT,
  ]
}

/**
 * Asks the phone, through wacli running on its own with the sync stopped, for older messages of one chat, and reports
 * what the mirror gained, measured by the mirror's coverage before and after. wacli's outcome is known by that
 * measurement, so a failure is never `uncertain`; only an abort (the service stopping or the deadline passing) is
 * left to the service, which answers it as a write.
 */
async function backfillHistory(
  args: unknown,
  { paths, env, signal }: ServiceOperationContext,
  limitMs: number,
): Promise<BackfillResult> {
  const parsed = backfillArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError(
      "invalid_argument",
      `${HISTORY_BACKFILL_OP} takes chat, a chat JID, and batches, a whole number from 1 to ${BACKFILL_BATCHES.max}.`,
    )
  }
  const { chat, batches } = parsed.data
  const before = await readCoverage(paths, chat, { env, signal })
  if (!before || before.held === 0) {
    throw new ToolError(
      "not_found",
      "The mirror holds no message of this chat to ask from; nothing was asked of the phone.",
    )
  }

  const result = await execWacli(paths, backfillArgs(chat, batches), {
    env,
    mode: "write",
    signal,
    timeoutMs: limitMs,
  })
  const { responses, reason } = readEvents(result.stderr)
  const after = await readCoverage(paths, chat, { env, signal })
  if (!after) throw new ToolError("upstream_error", "The mirror no longer shows this chat after the request.")
  const added = Math.max(0, after.held - before.held)
  const measured = { chat, added, held: after.held, oldest_ms: after.oldestMs, responses }

  const finished = result.code === 0 && !result.timedOut && !result.signal && readEnvelope(result.stdout)?.success
  if (finished) return { ...measured, stopped: STOPPED_BY_REASON.get(reason ?? "") ?? "batches_done" }

  const silent = result.timedOut || NO_ANSWER.test(failureText(result) ?? "")
  if (silent) {
    if (responses === 0 && added === 0) throw new ToolError("upstream_error", PHONE_SILENT)
    return { ...measured, stopped: result.timedOut ? "time_limit" : "no_answer" }
  }
  if (added > 0) return { ...measured, stopped: "error" }
  throw wacliError(result, "ask", limitMs)
}

/** The time limits of the operation, which tests shorten. */
export type BackfillLimits = {
  /** How long wacli may run for one backfill; `BACKFILL_WACLI_LIMIT_MS` by default. */
  wacliMs?: number
}

/**
 * The `history_backfill` operation. wacli does not hand it to a running sync, and it holds the store's lock, so it
 * runs with the child stopped; it changes the local mirror only.
 */
export function backfillOperation({ wacliMs = BACKFILL_WACLI_LIMIT_MS }: BackfillLimits = {}): ServiceOperation {
  return {
    kind: "exclusive",
    writes: true,
    run: (args, context) => backfillHistory(args, context, wacliMs),
  }
}
