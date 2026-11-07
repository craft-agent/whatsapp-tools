import type { LabelPaths } from "./labels"
import { writeServiceStatus, type ServiceEvent, type ServiceState } from "./service-status"
import { FREQUENT_EVENTS } from "./sync-events"

/** The states in which the service process is alive, and so has a process id to record. */
const LIVE_STATES: ReadonlySet<ServiceState> = new Set(["starting", "running", "paused"])

/** Records where the running service stands in its status file. */
export type StatusRecorder = {
  /** Enters `state`, with the reason for a state it ended in. */
  set(state: ServiceState, reason?: string): void
  /** Notes an event of wacli; the file is rewritten for it unless events of its kind come in bursts. */
  event(name: string): void
}

/**
 * A recorder for one run. The status is a courtesy to whoever reads it: a file that cannot be written is left as it
 * was, and the run goes on.
 */
export function createStatusRecorder(paths: LabelPaths, now: () => Date): StatusRecorder {
  let state: ServiceState = "starting"
  let since = now().toISOString()
  let reason: string | undefined
  let lastEvent: ServiceEvent | undefined

  const write = () => {
    try {
      writeServiceStatus(paths, {
        state,
        pid: LIVE_STATES.has(state) ? process.pid : null,
        since,
        ...(lastEvent ? { last_event: lastEvent } : {}),
        ...(reason !== undefined ? { reason } : {}),
      })
    } catch {
      // The file stays as it was; the run goes on.
    }
  }

  return {
    set(next, nextReason) {
      state = next
      reason = nextReason
      since = now().toISOString()
      write()
    },
    event(name) {
      lastEvent = { name, at: now().toISOString() }
      if (!FREQUENT_EVENTS.has(name)) write()
    },
  }
}
