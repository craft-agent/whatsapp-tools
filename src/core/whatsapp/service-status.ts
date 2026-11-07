import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import type { LabelPaths } from "./labels"
import { maskNumbers } from "./mask"

/** Owner read and write only, like the rest of the label's state. */
const STATUS_MODE = 0o600

/** Where the sync service of a label stands. */
export const SERVICE_STATES = ["starting", "running", "paused", "stopped", "failed", "revoked", "not_paired"] as const

export type ServiceState = (typeof SERVICE_STATES)[number]

/** The last event wacli reported, by name and when the service saw it (ISO 8601). */
export type ServiceEvent = { name: string; at: string }

/** What the sync service last recorded about itself, in `paths.serviceStatus`. */
export type ServiceStatus = {
  state: ServiceState
  /** The service's process id while it runs (`starting`, `running`, `paused`); null once it ended. */
  pid: number | null
  /** When the service entered `state` (ISO 8601). */
  since: string
  last_event?: ServiceEvent
  /** Why, in words without content, ids or numbers; numbers are masked on writing. */
  reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isState(value: unknown): value is ServiceState {
  return SERVICE_STATES.some((state) => state === value)
}

function readEvent(value: unknown): ServiceEvent | undefined {
  return isRecord(value) && typeof value.name === "string" && typeof value.at === "string"
    ? { name: value.name, at: value.at }
    : undefined
}

/**
 * Writes the status file atomically (a temporary file beside it, then a rename), readable by the owner only. The
 * reason is masked: no number or JID text reaches the file. Throws when the file cannot be written.
 */
export function writeServiceStatus(paths: LabelPaths, status: ServiceStatus): void {
  const { state, pid, since, last_event, reason } = status
  const record: ServiceStatus = {
    state,
    pid,
    since,
    ...(last_event ? { last_event } : {}),
    ...(reason !== undefined ? { reason: maskNumbers(reason) } : {}),
  }
  const temporary = `${paths.serviceStatus}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: STATUS_MODE })
    renameSync(temporary, paths.serviceStatus)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/** The status the service last recorded, or null when there is none or the file cannot be read. */
export function readServiceStatus(paths: LabelPaths): ServiceStatus | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(paths.serviceStatus, "utf8"))
  } catch {
    return null
  }
  if (!isRecord(parsed) || !isState(parsed.state) || typeof parsed.since !== "string") return null
  const { pid } = parsed
  if (pid !== null && !(typeof pid === "number" && Number.isInteger(pid))) return null
  const lastEvent = readEvent(parsed.last_event)
  return {
    state: parsed.state,
    pid,
    since: parsed.since,
    ...(lastEvent ? { last_event: lastEvent } : {}),
    ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
  }
}
