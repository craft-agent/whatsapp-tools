import type { LabelPaths } from "./labels"
import { errorText } from "./sync-ending"
import { syncArgv } from "./sync-args"
import { CONNECTED_EVENT, LOGGED_OUT_EVENT, parseEvent, type WacliEvent } from "./sync-events"
import { wacliEnv } from "./wacli"
import { spawnWacli, type WacliExit } from "./wacli-process"

export type SyncChildOptions = {
  /** The wacli program to run. */
  program: string
  paths: LabelPaths
  /** The caller's environment; `wacliEnv` picks what the child gets from it. */
  env: Record<string, string | undefined>
  /** Receives each event the child reports. */
  onEvent(event: WacliEvent): void
  /** Receives each other line of the child's standard error, masked. */
  onLine(line: string): void
  stopGraceMs?: number
}

/** How the child ended. */
export type SyncChildEnd = {
  /** What to say about it, in words without content, ids or numbers. */
  reason: string
  /** Whether the child reported `logged_out` before it ended. */
  loggedOut: boolean
  /** Whether the service stopped it (`stop` was called) rather than it ending on its own. */
  stoppedByService: boolean
}

/** The `wacli sync --follow` process the sync service runs. */
export type SyncChild = {
  /** Settles, never rejecting, once the child is gone and its output was delivered. */
  ended: Promise<SyncChildEnd>
  /**
   * Resolves, never rejecting, when the child reports `connected` for the first time since it was started; stays
   * pending when it ends first. A later `disconnected` does not undo it: the child still holds the store's lock.
   */
  ready: Promise<void>
  /** Stops the child gracefully (SIGTERM, then SIGKILL after the grace period) and resolves once it is gone. */
  stop(): Promise<void>
}

function describeExit({ code, signal }: WacliExit): string {
  return `wacli exited (${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`})`
}

/** Starts the sync child. A start that fails ends the child at once, with the failure as its reason. */
export function startSyncChild(options: SyncChildOptions): SyncChild {
  const { program, paths, env, onEvent, onLine, stopGraceMs } = options
  let loggedOut = false
  let stoppedByService = false
  let markReady = () => {}
  const ready = new Promise<void>((resolve) => (markReady = resolve))

  const wacli = spawnWacli(program, syncArgv(paths), {
    env: wacliEnv(env, paths),
    stopGraceMs,
    onStderrLine(line) {
      const event = parseEvent(line)
      if (!event) return onLine(line)
      if (event.name === LOGGED_OUT_EVENT) loggedOut = true
      onEvent(event)
      if (event.name === CONNECTED_EVENT) markReady()
    },
  })

  const ended = wacli.exited.then(
    (exit) => ({ reason: describeExit(exit), loggedOut, stoppedByService }),
    (error: unknown) => ({ reason: errorText(error), loggedOut, stoppedByService }),
  )

  return {
    ended,
    ready,
    async stop() {
      stoppedByService = true
      await wacli.stop()
    },
  }
}

/** Resolves true once the child is ready, false when it ends or `signal` aborts first. */
export function waitUntilReady(child: SyncChild, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const finish = (ready: boolean) => {
      signal.removeEventListener("abort", onAbort)
      resolve(ready)
    }
    const onAbort = () => finish(false)
    signal.addEventListener("abort", onAbort, { once: true })
    void child.ready.then(() => finish(true))
    void child.ended.then(() => finish(false))
  })
}
