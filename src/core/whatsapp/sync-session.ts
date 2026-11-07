import type { LabelPaths } from "./labels"
import { runWacli } from "./wacli"

/** How long `doctor` may take. */
const DOCTOR_TIMEOUT_MS = 20_000

/** What `doctor` says of the label's session: usable (or not told), no device paired, or revoked by WhatsApp. */
export type SessionState = "ok" | "not_paired" | "revoked"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** What `doctor` says of the label's session and of the process holding its store. */
export type SessionReport = {
  state: SessionState
  /** The process id of the wacli that holds the store's lock, when `doctor` names one. */
  lockOwnerPid?: number
}

/**
 * Asks `wacli doctor --read-only` about the label's session and the store's lock, which works while a sync holds the
 * store. A revoked session wins over an unauthenticated one, since it names why there is no usable device. Throws as
 * `runWacli` does.
 */
export async function inspectSession(
  paths: LabelPaths,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<SessionReport> {
  const report = await runWacli(paths, ["doctor"], { env, mode: "read", signal, timeoutMs: DOCTOR_TIMEOUT_MS })
  if (!isRecord(report)) return { state: "ok" }
  const state = report.session_revoked === true ? "revoked" : report.authenticated === false ? "not_paired" : "ok"
  const owner = report.lock_held === true ? report.lock_owner_pid : undefined
  const lockOwnerPid = typeof owner === "number" && Number.isInteger(owner) && owner > 0 ? owner : undefined
  return { state, ...(lockOwnerPid !== undefined ? { lockOwnerPid } : {}) }
}

/** The state of the label's session, as `inspectSession` reads it. */
export async function checkSession(
  paths: LabelPaths,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<SessionState> {
  return (await inspectSession(paths, env, signal)).state
}
