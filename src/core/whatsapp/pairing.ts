import type { Stats } from "node:fs"
import { lstat, rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import { abortError, type ExecResult } from "../exec"
import { checkLabel, ensureLabelDir, type LabelPaths } from "./labels"
import { isServiceRunning } from "./service-lock"
import { CONNECTED_EVENT, parseEvent } from "./sync-events"
import { inspectSession } from "./sync-session"
import { checkWacli, readEnvelope, wacliArgs, wacliEnv, wacliError } from "./wacli"
import { spawnWacli } from "./wacli-process"

/** How long a person has to scan the code or type the pairing code, and for the first sync that follows. */
const DEFAULT_TIMEOUT_MS = 600_000

/** The same, when the phone sends its full history, which takes longer. */
const FULL_HISTORY_TIMEOUT_MS = 1_800_000

/** The session's files in the store: wacli's database of the keys, and its journal files. The mirror is not among them. */
const SESSION_FILES = ["session.db", "session.db-wal", "session.db-shm"]

/** The events of `wacli auth --events` that carry what the person scans or types. */
const QR_CODE_EVENT = "qr_code"
const PAIR_CODE_EVENT = "pair_code"

/** What a phone number may look like: an optional `+`, then digits that spaces and dashes may separate. */
const PHONE_FORMAT = /^\+?\d(?:[ -]?\d)*$/
const MIN_PHONE_DIGITS = 7
const MAX_PHONE_DIGITS = 15

/** How many of wacli's last lines of output an error can draw on. */
const TAIL_LINES = 50

/** wacli's text when no device scanned the code in time. */
const QR_TIMED_OUT = /QR code timed out/i

const PHONE_RULE = `The phone number must have ${MIN_PHONE_DIGITS} to ${MAX_PHONE_DIGITS} digits, with an optional leading "+" and spaces or dashes between digits.`
const SERVICE_RUNNING = "The sync service for this label is running; stop its sync service first."
const ALREADY_PAIRED = "This label is already paired; remove it first, or pair under another label."
const STORE_NOT_A_DIRECTORY = "The label's wacli store is not a directory (it may be a link); nothing was deleted."
const NOT_PAIRED_IN_TIME = "No device was paired in time; pair again to get a new code."

export type PairOptions = {
  stateDir: string
  label: string
  /** The caller's environment; wacli gets only what `wacliEnv` picks from it. */
  env: Record<string, string | undefined>
  /** The phone's number, to pair with a code typed on the phone instead of a code scanned; `+`, spaces and dashes are accepted. */
  phone?: string
  /** Stops wacli and rejects with an `AbortError` when it aborts. */
  signal: AbortSignal
  /** Receives the payload of each QR code to draw, as wacli renews it. Never log it. */
  onQrCode(code: string): void
  /** Receives the code to type on the phone. Never log it. */
  onPairCode(code: string): void
  /** Asks the phone for its full history instead of its recent window; it only takes effect while pairing. */
  fullHistory?: boolean
  /** With `fullHistory`: how many days back the phone sends; unset or 0 lets the phone decide. */
  historyDays?: number
  /**
   * How long the person has to pair, the first sync included; 10 minutes by default, 30 minutes with `fullHistory`.
   * Once wacli is connected, running out of it ends the pairing as done instead of failing.
   */
  timeoutMs?: number
}

export type PairResult = {
  /** How many messages the first sync stored, when wacli says. */
  messagesStored: number | null
}

/** The digits of a phone number, or `invalid_argument`; the message never repeats what was given. */
export function normalizePhone(phone: string): string {
  const text = phone.trim()
  const digits = text.replace(/\D/g, "")
  if (!PHONE_FORMAT.test(text) || digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    throw new ToolError("invalid_argument", PHONE_RULE)
  }
  return digits
}

/**
 * Refuses a label that is paired, and clears a session WhatsApp revoked (its files only, the mirror stays) so that
 * `auth` pairs again instead of connecting to a dead session.
 */
async function prepareSession(
  paths: LabelPaths,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<void> {
  const { state } = await inspectSession(paths, env, signal)
  if (state === "ok") throw new ToolError("invalid_argument", ALREADY_PAIRED)
  if (state === "revoked") await clearRevokedSession(paths)
}

/** What is at `path` without following a link, or undefined when there is nothing. */
async function lstatOrNothing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Deletes the revoked session's files from the store. The store must be a real directory, not a link that leads
 * elsewhere, and only regular files are deleted: anything else is left where it is.
 */
async function clearRevokedSession(paths: LabelPaths): Promise<void> {
  const store = await lstatOrNothing(paths.store)
  if (!store) return
  if (!store.isDirectory()) throw new ToolError("invalid_argument", STORE_NOT_A_DIRECTORY)
  for (const name of SESSION_FILES) {
    const file = join(paths.store, name)
    if ((await lstatOrNothing(file))?.isFile()) await rm(file, { force: true })
  }
}

/** The last `TAIL_LINES` lines handed to it. */
function lineTail(): { push(line: string): void; text(): string } {
  const lines: string[] = []
  return {
    push(line) {
      lines.push(line)
      if (lines.length > TAIL_LINES) lines.shift()
    },
    text: () => lines.join("\n"),
  }
}

/** The number of messages in the data of a finished pairing, or null when wacli did not say. */
function messagesStored(data: unknown): number | null {
  const count = (data as { messages_stored?: unknown } | null)?.messages_stored
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null
}

/** The data of the success envelope of an authenticated wacli in `stdout`, or undefined. */
function authenticatedData(stdout: string): unknown {
  const envelope = readEnvelope(stdout)
  const data = envelope?.success ? envelope.data : undefined
  return (data as { authenticated?: unknown } | null | undefined)?.authenticated === true ? data : undefined
}

/** The arguments of `wacli auth`, after the global ones. */
function authArgs(phone: string | undefined, { fullHistory, historyDays }: PairOptions): string[] {
  return [
    "auth",
    "--events",
    ...(phone === undefined ? [] : ["--phone", phone]),
    ...(fullHistory ? ["--full-history"] : []),
    ...(fullHistory && historyDays !== undefined ? ["--history-days", String(historyDays)] : []),
  ]
}

/**
 * Runs `wacli auth --events` until it ends, is aborted or runs out of time; wacli has ended when this settles.
 * Out of time after wacli connected is a pairing that is done: wacli is stopped and its syncing left to the service.
 */
async function runAuth(
  program: string,
  paths: LabelPaths,
  phone: string | undefined,
  options: PairOptions,
): Promise<PairResult> {
  const { env, signal, onQrCode, onPairCode, fullHistory } = options
  const timeoutMs = options.timeoutMs ?? (fullHistory ? FULL_HISTORY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS)
  const stdout = lineTail()
  const stderr = lineTail()
  let connected = false

  const child = spawnWacli(program, wacliArgs(paths, authArgs(phone, options), { readOnly: false }), {
    env: wacliEnv(env, paths),
    onStdoutLine: stdout.push,
    // The codes are read before masking, which would eat the digit runs in them, and are kept out of `stderr`.
    onRawStderrLine(line) {
      const event = parseEvent(line)
      if (event?.name !== QR_CODE_EVENT && event?.name !== PAIR_CODE_EVENT) return false
      const code = event.data.code
      if (typeof code === "string") (event.name === QR_CODE_EVENT ? onQrCode : onPairCode)(code)
      return true
    },
    onStderrLine(line) {
      if (parseEvent(line)?.name === CONNECTED_EVENT) connected = true
      stderr.push(line)
    },
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<"timeout" | "abort">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs)
    onAbort = () => resolve("abort")
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })

  try {
    const outcome = await Promise.race([child.exited, interrupted])
    if (outcome === "abort") throw abortError(signal)
    if (outcome === "timeout") {
      if (!connected) throw new ToolError("upstream_error", NOT_PAIRED_IN_TIME)
      await child.stop()
      return { messagesStored: messagesStored(authenticatedData(stdout.text())) }
    }

    const result: ExecResult = {
      code: outcome.code ?? -1,
      stdout: stdout.text(),
      stderr: stderr.text(),
      ...(outcome.signal ? { signal: outcome.signal } : {}),
    }
    if (result.code === 0 && !result.signal) {
      const data = authenticatedData(result.stdout)
      if (data !== undefined) return { messagesStored: messagesStored(data) }
    }
    if (QR_TIMED_OUT.test(result.stderr)) throw new ToolError("upstream_error", NOT_PAIRED_IN_TIME)
    throw wacliError(result, "read")
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener("abort", onAbort)
    await child.stop()
  }
}

/**
 * Pairs this machine as a linked device of the person's phone under a label.
 *
 * Refuses while the label's sync service runs, which holds the store, and a label that is paired; a session
 * WhatsApp revoked is cleared first (its files only, the mirror stays). Runs `wacli auth --events`, hands each QR
 * code, or the code to type on the phone when `phone` is given, to the callbacks, and waits for the pairing and the
 * first sync that wacli runs after it. With `fullHistory` the phone is asked for its full history (`historyDays`
 * limits how far back), which wacli only does while pairing; what is still unsent when wacli ends reaches the
 * mirror later through the sync service. When the time limit passes after wacli connected, wacli is stopped and the
 * device counts as paired (`messagesStored` is null unless wacli had printed its result); before that it fails as
 * not paired in time. wacli never outlives the call. The codes reach the callbacks only: they are in no message,
 * error or log.
 */
export async function pairDevice(options: PairOptions): Promise<PairResult> {
  const { stateDir, label, env, signal } = options
  if (signal.aborted) throw abortError(signal)
  checkLabel(label)
  const phone = options.phone === undefined ? undefined : normalizePhone(options.phone)

  const paths = await ensureLabelDir(stateDir, label)
  if (isServiceRunning(paths)) throw new ToolError("invalid_argument", SERVICE_RUNNING)
  const { program } = await checkWacli(env, { signal })
  await prepareSession(paths, env, signal)
  return runAuth(program, paths, phone, options)
}
