import { setTimeout as delay } from "node:timers/promises"
import { isAlive } from "./service-lock"

/** How long a wacli left behind may take to exit after SIGTERM before it is sent SIGKILL. */
export const DEFAULT_STALE_GRACE_MS = 15_000

/** How long a wacli left behind may take to disappear after SIGKILL. */
const KILL_WAIT_MS = 5_000

/** How often a process that was signalled is looked for. */
const POLL_MS = 50

/** Resolves true once the process is gone, false when it is still there after `ms` or `signal` aborts. */
async function goneWithin(pid: number, ms: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + ms
  while (isAlive(pid)) {
    if (signal.aborted || Date.now() >= deadline) return false
    await delay(POLL_MS, undefined, { signal }).catch(() => {})
  }
  return true
}

/** Sends the signal; false when it could not be sent (the process is gone, or is not ours to signal). */
function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Stops the wacli that holds a label's store although no sync service runs for it, left behind by a service that was
 * killed: SIGTERM, then SIGKILL after `graceMs`, then a bounded wait. Only `pid` is touched, and the caller has
 * checked that it is another live process. Resolves whether the process is gone.
 */
export async function stopStaleWacli(
  pid: number,
  { graceMs, log, signal }: { graceMs: number; log(line: string): void; signal: AbortSignal },
): Promise<boolean> {
  log(`stopping a wacli left behind by an earlier service (pid ${pid})`)
  if (!signalProcess(pid, "SIGTERM")) return !isAlive(pid)
  if (await goneWithin(pid, graceMs, signal)) return true
  if (signal.aborted) return false
  log(`the wacli left behind (pid ${pid}) ignored SIGTERM; killing it`)
  if (!signalProcess(pid, "SIGKILL")) return !isAlive(pid)
  return goneWithin(pid, KILL_WAIT_MS, signal)
}
