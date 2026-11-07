import { lstat, rm } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { ToolError, isAbortError } from "../errors"
import { isWithin } from "../paths"
import { checkLabel, labelPaths, listLabels, type LabelPaths } from "./labels"
import { readServicePid } from "./service-lock"
import { inspectSession } from "./sync-session"
import { runWacli } from "./wacli"

/**
 * How long removal waits for the sync service to exit after it was uninstalled: the service stops its child
 * gracefully, which takes up to 15 seconds.
 */
const DEFAULT_POLL_TIMEOUT_MS = 20_000

/** How often removal checks whether the sync service is still alive. */
const DEFAULT_POLL_INTERVAL_MS = 100

/** How long `wacli auth logout` may take, which includes connecting to WhatsApp. */
const LOGOUT_TIMEOUT_MS = 30_000

export type RemoveLabelOptions = {
  /** The state directory containing the label directories. */
  stateDir: string
  /** The account label to remove. */
  label: string
  /** The caller's environment; wacli gets only what `wacliEnv` picks from it. */
  env: Record<string, string | undefined>
  /** Stops and removes the system's sync service for the label before anything is removed; may do nothing. */
  uninstall(): Promise<void>
  /** Stops waiting and rejects with an `AbortError` when it aborts; nothing is deleted then. */
  signal?: AbortSignal
  /** How long to wait for the sync service to exit; 20 seconds by default. */
  pollTimeoutMs?: number
  /** How often to check whether the sync service is still alive; 100 ms by default. */
  pollIntervalMs?: number
}

export type RemoveLabelResult = {
  /** Whether wacli logged the device out, so that the phone no longer lists it. */
  loggedOut: boolean
}

/** Refuses a label directory that is a link or a file; a missing one passes only when `mayBeMissing`. */
async function checkDirectory(paths: LabelPaths, { mayBeMissing }: { mayBeMissing: boolean }): Promise<void> {
  const stat = await lstat(paths.dir).catch(() => undefined)
  if (stat === undefined && mayBeMissing) return
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" is not a directory.`)
  }
}

/** Waits until the label's sync service is gone, or fails with `upstream_error` once `timeoutMs` has passed. */
async function waitForServiceToExit(
  paths: LabelPaths,
  { timeoutMs, intervalMs, signal }: { timeoutMs: number; intervalMs: number; signal?: AbortSignal },
): Promise<void> {
  const start = Date.now()
  while (readServicePid(paths) !== undefined) {
    const left = timeoutMs - (Date.now() - start)
    if (left <= 0) {
      throw new ToolError("upstream_error", "The sync service for this label is still running; stop it first.")
    }
    await delay(Math.min(intervalMs, left), undefined, { signal })
  }
}

/**
 * Logs the device out when the label is paired and its session is not revoked, so that the phone drops it. A
 * failure to do so is not fatal, since the label is removed anyway: it reports `false`. An abort is not a failure.
 */
async function logOut(
  paths: LabelPaths,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    if ((await inspectSession(paths, env, signal)).state !== "ok") return false
    await runWacli(paths, ["auth", "logout"], { env, mode: "write", signal, timeoutMs: LOGOUT_TIMEOUT_MS })
    return true
  } catch (error) {
    if (isAbortError(error)) throw error
    return false
  }
}

/**
 * Permanently removes a label and its entire state directory.
 *
 * Checks that the label exists as a real directory, uninstalls the sync service and waits for its process to
 * exit (failing with `upstream_error`, nothing deleted, when it stays), logs the device out of WhatsApp when it is
 * paired, and recursively deletes the label directory once it is verified to lie inside the state directory.
 * A logout that fails does not stop the removal; `loggedOut` says whether it happened.
 */
export async function removeLabel(options: RemoveLabelOptions): Promise<RemoveLabelResult> {
  const { stateDir, label, env, uninstall, signal } = options
  checkLabel(label)
  const paths = labelPaths(stateDir, label)

  await checkDirectory(paths, { mayBeMissing: true })
  const labels = await listLabels(stateDir)
  if (!labels.includes(label)) {
    const known = labels.length > 0 ? `known accounts: ${labels.join(", ")}.` : "no WhatsApp account is paired yet."
    throw new ToolError("not_found", `WhatsApp account "${label}" was not found; ${known}`)
  }

  await uninstall()
  await waitForServiceToExit(paths, {
    timeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    signal,
  })
  const loggedOut = await logOut(paths, env, signal ?? new AbortController().signal)

  await checkDirectory(paths, { mayBeMissing: false })
  if (!(await isWithin(paths.dir, stateDir))) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" is not inside state directory.`)
  }
  await rm(paths.dir, { recursive: true, force: true })
  return { loggedOut }
}
