import { isAbortError } from "../errors"
import type { LabelPaths } from "./labels"
import { isAlive } from "./service-lock"
import {
  NOT_PAIRED_REASON,
  REVOKED_REASON,
  STOPPED_OUTCOME,
  errorText,
  failedOutcome,
  type SyncOutcome,
} from "./sync-ending"
import { inspectSession, type SessionState } from "./sync-session"
import { stopStaleWacli } from "./sync-stale"
import { checkWacli } from "./wacli"

/** Why a run ends when a wacli it could not stop holds the label's store. */
export const STORE_HELD_REASON = "the account's store is held by another wacli process"

export type StartOptions = {
  env: Record<string, string | undefined>
  signal: AbortSignal
  log(line: string): void
  /** How long a wacli left behind may take to exit after SIGTERM. */
  staleGraceMs: number
}

/** What the checks before the child starts decide: to start it with `program`, or to end the run as `outcome`. */
export type StartDecision = { program: string } | { outcome: SyncOutcome }

/** The outcome of a session that cannot run a sync, or undefined for one that can. */
function sessionOutcome(state: SessionState): SyncOutcome | undefined {
  if (state === "not_paired") return { exitCode: 0, state, reason: NOT_PAIRED_REASON }
  if (state === "revoked") return { exitCode: 0, state, reason: REVOKED_REASON }
  return undefined
}

/**
 * The checks that come after the service took the label's lock and before the child starts: wacli is supported, a
 * device is paired and its session not revoked, and no wacli left behind by a killed service holds the store (it is
 * stopped, SIGTERM then SIGKILL, and the session looked at again).
 */
export async function checkBeforeStart(paths: LabelPaths, options: StartOptions): Promise<StartDecision> {
  const { env, signal, log, staleGraceMs } = options
  try {
    if (signal.aborted) return { outcome: STOPPED_OUTCOME }
    const { program } = await checkWacli(env, { signal })
    const report = await inspectSession(paths, env, signal)
    const ended = sessionOutcome(report.state)
    if (ended) return { outcome: ended }

    const { lockOwnerPid: stale } = report
    if (stale !== undefined && stale !== process.pid && isAlive(stale)) {
      const gone = await stopStaleWacli(stale, { graceMs: staleGraceMs, log, signal })
      if (signal.aborted) return { outcome: STOPPED_OUTCOME }
      if (!gone) return { outcome: failedOutcome(STORE_HELD_REASON) }
      const afterwards = sessionOutcome((await inspectSession(paths, env, signal)).state)
      if (afterwards) return { outcome: afterwards }
    }
    return { program }
  } catch (error) {
    return { outcome: isAbortError(error) ? STOPPED_OUTCOME : failedOutcome(errorText(error)) }
  }
}
