import { setTimeout as delay } from "node:timers/promises"
import { ToolError, isToolError } from "../errors"
import { ensureLabelDir, type LabelPaths } from "./labels"
import { acquireServiceLock } from "./service-lock"
import {
  listenOnServiceSocket,
  type ServiceExecutor,
  type ServiceOperation,
  type ServiceOperationContext,
  type ServiceOperations,
  type ServiceRunning,
  type ServiceSocket,
} from "./service-socket"
import { startSyncChild, waitUntilReady, type SyncChild } from "./sync-child"
import { Ending, errorText, failedOutcome, settle, type Ended, type SyncOutcome } from "./sync-ending"
import { describeEvent, type WacliEvent } from "./sync-events"
import { DEFAULT_STALE_GRACE_MS } from "./sync-stale"
import { checkBeforeStart } from "./sync-start"
import { createStatusRecorder, type StatusRecorder } from "./sync-status"

export type { SyncOutcome } from "./sync-ending"

/** Why a run does not start when another holds the label's lock. */
export const ALREADY_RUNNING_REASON = "already running"

/** The pause between an operation that ran with the child stopped and the child starting again. */
const DEFAULT_RESTART_DELAY_MS = 1_000

/** How long a child started again after an exclusive operation must stay up before the caller is told it runs. */
const DEFAULT_STARTED_GRACE_MS = 1_000

const NOT_CONNECTED = "The sync service is not connected; try again shortly."

const NOT_CONNECTED_YET = "The sync service is not connected yet; nothing was sent."

const NOT_RESTARTED =
  "The sync service did not start syncing again, so the mirror receives nothing until the service is started."

export type SyncOptions = {
  /** The state root; the label's directory is created in it. */
  stateDir: string
  label: string
  /** The caller's environment; wacli and its child get only what `wacliEnv` picks from it. */
  env: Record<string, string | undefined>
  /** Aborts to stop the service: the child is stopped gracefully and the run ends with exit code 0. */
  signal: AbortSignal
  /** Receives each line the service logs, without a time or a line break. */
  log(line: string): void
  /** What callers may ask of the service over its socket; none by default. */
  operations?: ServiceOperations
  now?(): Date
  /** The pause before the child starts again after an operation that ran with it stopped; one second by default. */
  restartDelayMs?: number
  /**
   * How long a child started again after an operation that ran with it stopped must stay up before the operation's
   * caller is told the service runs (`service_running`); one second by default.
   */
  startedGraceMs?: number
  /** How long a wacli left behind by a killed service may take to exit after SIGTERM before it is killed; 15 seconds by default. */
  staleStopGraceMs?: number
}

type ExclusiveOperation = Extract<ServiceOperation, { kind: "exclusive" }>

/** What the supervision of one run works on. */
type Run = {
  paths: LabelPaths
  options: SyncOptions
  /** The checked wacli program. */
  program: string
  recorder: StatusRecorder
}

function outcomeLine({ state, reason }: SyncOutcome): string {
  if (state === "stopped") return "stopped"
  return state === "failed" ? `sync ended: ${reason}` : `${reason}; staying down`
}

/** Runs the sync child and the socket until something ends them; resolves with the outcome, with nothing left running. */
async function supervise({ paths, options, program, recorder }: Run): Promise<SyncOutcome> {
  const {
    env,
    signal,
    log,
    operations = {},
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    startedGraceMs = DEFAULT_STARTED_GRACE_MS,
  } = options
  const ending = new Ending()
  // Typed by assertion: it is assigned inside closures, where flow analysis would narrow it to `undefined`.
  let child = undefined as SyncChild | undefined
  let socket: ServiceSocket | undefined

  const startChild = () => {
    const started = startSyncChild({
      program,
      paths,
      env,
      onEvent(event: WacliEvent) {
        log(describeEvent(event))
        recorder.event(event.name)
      },
      onLine: log,
    })
    child = started
    // The service is running once the child is connected; until then it is starting, after every start of the child.
    void started.ready.then(() => {
      if (child !== started || ending.settled) return
      recorder.set("running")
      log("running")
    })
    void started.ended.then(({ reason, loggedOut, stoppedByService }) => {
      // A stop the service made itself is no end, unless WhatsApp ended the session as it happened.
      if (!stoppedByService || loggedOut) ending.end({ kind: "child", reason, loggedOut })
    })
  }

  /**
   * Starts the child again after an exclusive operation, unless the service is ending; a failure to start ends it.
   * Resolves whether the child was started and still runs `startedGraceMs` later: a child that ends at once takes the
   * service with it.
   */
  const restartChild = async (): Promise<boolean> => {
    await delay(restartDelayMs, undefined, { signal: ending.signal }).catch(() => {})
    if (ending.settled) return false
    try {
      recorder.set("starting")
      startChild()
    } catch (error) {
      ending.end({ kind: "child", reason: `wacli could not be started again: ${errorText(error)}`, loggedOut: false })
      return false
    }
    const started = child!
    if (!(await started.started)) return false
    const endedSoon = await Promise.race([
      started.ended.then(() => true),
      delay(startedGraceMs, false, { signal: ending.signal }).catch(() => true),
    ])
    return !endedSoon && !ending.settled
  }

  const runExclusive = async (operation: ExclusiveOperation, args: unknown, context: ServiceOperationContext) => {
    const stopping = child!
    child = undefined
    recorder.set("paused")
    let result: Record<string, unknown>
    try {
      await stopping.stop()
      result = await operation.run(args, context)
    } catch (error) {
      const running = await restartChild()
      if (!running && isToolError(error)) {
        throw new ToolError(error.code, `${error.message} ${NOT_RESTARTED}`, { cause: error })
      }
      throw error
    }
    return { ...result, service_running: await restartChild() } satisfies ServiceRunning
  }

  /**
   * An exclusive operation needs the child running only to stop it. A delegated one must not run before the current
   * child is ready (has reported `connected`): wacli hands a write to a sync that holds the store's lock, and a write
   * that finds the store unlocked would connect to WhatsApp on its own. It waits until the request's deadline, and is
   * refused, with nothing sent, when the deadline passes first or the child ends.
   */
  const execute: ServiceExecutor = async (operation, args, opSignal) => {
    const current = child
    const context = { paths, env, signal: opSignal }
    if (operation.kind === "exclusive") {
      if (ending.settled || !current) throw new ToolError("upstream_error", NOT_CONNECTED)
      return runExclusive(operation, args, context)
    }
    if (ending.settled || !current || !(await waitUntilReady(current, opSignal)) || ending.settled) {
      throw new ToolError("upstream_error", NOT_CONNECTED_YET)
    }
    return operation.run(args, context)
  }

  const onAbort = () => ending.end({ kind: "abort" })
  if (signal.aborted) onAbort()
  else signal.addEventListener("abort", onAbort, { once: true })

  let ended: Ended
  try {
    socket = await listenOnServiceSocket(paths.socket, { operations, execute, log })
    if (!ending.settled) startChild()
    ended = await ending.promise
  } catch (error) {
    ending.end({ kind: "child", reason: errorText(error), loggedOut: false })
    ended = await ending.promise
  } finally {
    signal.removeEventListener("abort", onAbort)
    await socket?.close()
    await child?.stop()
  }
  return settle(ended, { paths, env, signal })
}

/** The checks that need the label's lock, then the run itself. */
async function runLocked(paths: LabelPaths, options: SyncOptions, recorder: StatusRecorder): Promise<SyncOutcome> {
  const { env, signal, log, staleStopGraceMs = DEFAULT_STALE_GRACE_MS } = options
  const decision = await checkBeforeStart(paths, { env, signal, log, staleGraceMs: staleStopGraceMs })
  if ("outcome" in decision) return decision.outcome
  return supervise({ paths, options, program: decision.program, recorder })
}

/**
 * Runs one label's sync service in the foreground: holds the label's lock, runs `wacli sync --follow` as its
 * child, serves the label's socket, and records its state in the status file.
 *
 * One run per label: a second run resolves as `failed` ("already running", exit code 1) at once, touching
 * nothing. With no paired device, or once WhatsApp revoked the session, it resolves (exit code 0, so the system
 * does not restart it) as `not_paired` or `revoked`; a child that reports `logged_out` or whose end `doctor`
 * explains as a revoked session ends the same way. A stop request (`signal`) stops the child gracefully and
 * resolves as `stopped` (exit code 0). Any other end of the child resolves as `failed` (exit code 1).
 *
 * Resolves with nothing left running: the child stopped, the socket closed and removed, the lock released.
 */
export async function runSync(options: SyncOptions): Promise<SyncOutcome> {
  const { stateDir, label, log } = options
  const now = options.now ?? (() => new Date())
  const paths = await ensureLabelDir(stateDir, label)

  const release = acquireServiceLock(paths.serviceLock)
  if (!release) {
    log(ALREADY_RUNNING_REASON)
    return failedOutcome(ALREADY_RUNNING_REASON)
  }
  try {
    const recorder = createStatusRecorder(paths, now)
    recorder.set("starting")
    log("starting")
    const outcome = await runLocked(paths, options, recorder)
    recorder.set(outcome.state, outcome.reason)
    log(outcomeLine(outcome))
    return outcome
  } finally {
    release()
  }
}
