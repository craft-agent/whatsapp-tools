import { ToolError, isAbortError } from "../errors"
import type { LabelPaths } from "./labels"
import { checkSession } from "./sync-session"
import type { ServiceState } from "./service-status"

/** How a run of the sync service ended. */
export type SyncOutcome = {
  /** What a process supervisor needs: 0 when there is nothing to run, the session is gone or a stop was requested; 1 after a failure worth a restart. */
  exitCode: 0 | 1
  state: Extract<ServiceState, "stopped" | "failed" | "revoked" | "not_paired">
  /** Why, in words without content, ids or numbers. */
  reason?: string
}

/** What ended the service: a stop request, or the child ending (on its own, or because it could not be started again). */
export type Ended = { kind: "abort" } | { kind: "child"; reason: string; loggedOut: boolean }

export const STOPPED_OUTCOME: SyncOutcome = { exitCode: 0, state: "stopped" }

/** What the log and the status say once WhatsApp ended the session. */
export const REVOKED_REASON = "WhatsApp revoked this session; the device has to be paired again"

/** What the log and the status say when no device is paired. */
export const NOT_PAIRED_REASON = "no WhatsApp device is paired for this account"

/** What an error says without anything from wacli's data: a `ToolError`'s message, else only the error's kind. */
export function errorText(error: unknown): string {
  if (error instanceof ToolError) return error.message
  return error instanceof Error ? error.name : "unexpected error"
}

/** The outcome of a run that failed for `reason`. */
export function failedOutcome(reason: string): SyncOutcome {
  return { exitCode: 1, state: "failed", reason }
}

/** The one reason a run ends for: whichever comes first wins. */
export class Ending {
  /** Resolves with the first reason given to `end`. */
  readonly promise: Promise<Ended>
  private readonly controller = new AbortController()
  private resolve: (ended: Ended) => void = () => {}
  private result: Ended | undefined

  constructor() {
    this.promise = new Promise((resolve) => (this.resolve = resolve))
  }

  /** Aborts once the run has ended, so waits and operations still going give up. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  get settled(): boolean {
    return this.result !== undefined
  }

  end(ended: Ended): void {
    if (this.result) return
    this.result = ended
    this.resolve(ended)
    this.controller.abort()
  }
}

/**
 * Decides the outcome of a run from what ended it: `logged_out` means revoked; a stop request (`signal` aborted)
 * means stopped; any other end of the child asks `doctor` whether the session was revoked, and otherwise is a
 * failure.
 */
export async function settle(
  ended: Ended,
  { paths, env, signal }: { paths: LabelPaths; env: Record<string, string | undefined>; signal: AbortSignal },
): Promise<SyncOutcome> {
  if (ended.kind === "child" && ended.loggedOut) return { exitCode: 0, state: "revoked", reason: REVOKED_REASON }
  if (ended.kind === "abort" || signal.aborted) return STOPPED_OUTCOME
  try {
    if ((await checkSession(paths, env, signal)) === "revoked") {
      return { exitCode: 0, state: "revoked", reason: REVOKED_REASON }
    }
  } catch (error) {
    if (isAbortError(error)) return STOPPED_OUTCOME
    // A session that cannot be asked about does not change why the child ended.
  }
  return failedOutcome(ended.reason)
}
