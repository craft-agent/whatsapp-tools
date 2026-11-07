import { constants } from "node:fs"
import { access, stat } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { ToolError, isAbortError } from "../errors"
import { exec, type ExecOptions, type ExecResult } from "../exec"
import { isRecord } from "./json-record"
import type { LabelPaths } from "./labels"
import { maskNumbers } from "./mask"

/** The oldest wacli the tools support. */
export const WACLI_MIN_VERSION = "0.26.0"

/** The program's file name on `PATH`. */
const PROGRAM_NAME = "wacli"

const WACLI_URL = "https://github.com/openclaw/wacli"

/** Where wacli is looked for after `PATH`: the usual package manager prefixes. */
export const FALLBACK_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"]

/** The only variables wacli gets from the caller: where to find itself and its home, and the locale. */
const PASSED_VARIABLES = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const

/** The variable that restricts which files a send may upload. */
const MEDIA_ROOTS_VARIABLE = "WACLI_MEDIA_ROOTS"

/** How long `wacli version` may take. */
const VERSION_TIMEOUT_MS = 10_000

/** How long a call may take unless the caller says otherwise. */
const DEFAULT_TIMEOUT_MS = 60_000

/** How much of wacli's own text an error carries. */
const MAX_DETAIL_LENGTH = 300

const NOT_INSTALLED = `${PROGRAM_NAME} is not installed or not on PATH; install it from ${WACLI_URL}.`

const UNCERTAIN_ADVICE = "Check before trying again."

/** wacli's text when no device is paired. */
const NOT_AUTHENTICATED = /not authenticated/i

/** wacli's texts when WhatsApp ended the session. */
const SESSION_ENDED = /session was revoked|login failed|logged out of whatsapp/i

/** wacli's texts when another process holds the store. */
const STORE_LOCKED = /store is locked|timed out waiting for store lock/i

/** wacli's texts when it refuses the call itself: read-only mode, or a command line cobra rejects. */
const REFUSED =
  /^(?:error:\s*)?(?:read-only mode:|unknown (?:flag|command|shorthand flag)|required flag|invalid argument|accepts \d+ arg)/i

/**
 * What a call may do. `read` only reads the store and runs with `--read-only`. `ask` writes nothing either but asks
 * WhatsApp, which wacli refuses under `--read-only`, so it runs without the flag. `write` may change the store or
 * WhatsApp. Only `write` reports an unknown outcome as `uncertain`; the other two report `upstream_error`.
 */
export type WacliMode = "read" | "ask" | "write"

export type WacliRunOptions = {
  /** The caller's environment; `wacliEnv` picks what wacli gets from it. */
  env: Record<string, string | undefined>
  mode: WacliMode
  signal?: AbortSignal
  /** How long wacli may take before it is stopped; 60 seconds by default. */
  timeoutMs?: number
}

/** The wacli found on the machine and its version. */
export type WacliInfo = { program: string; version: string }

/** The `upstream_error` for an installed wacli older than `WACLI_MIN_VERSION`, carrying the version it found. */
export class WacliTooOldError extends ToolError {
  readonly version: string

  constructor(version: string) {
    super(
      "upstream_error",
      `wacli ${version} is older than ${WACLI_MIN_VERSION}, which these tools need; update wacli (${WACLI_URL}).`,
    )
    this.version = version
  }
}

/** What wacli prints for every call that is asked for JSON. */
export type Envelope = { success: boolean; data?: unknown; error?: unknown }

/** The checked wacli by program path, for the life of the process. */
const checked = new Map<string, WacliInfo>()

/** Forgets which wacli programs were checked; for tests. */
export function resetWacliCache(): void {
  checked.clear()
}

/**
 * The environment wacli runs with: only what it needs to find itself, and nothing else from `env`. With `paths`,
 * `WACLI_MEDIA_ROOTS` names the label's outbox, so wacli refuses to upload any other file.
 */
export function wacliEnv(env: Record<string, string | undefined>, paths?: LabelPaths): Record<string, string> {
  const passed: Record<string, string> = {}
  for (const name of PASSED_VARIABLES) {
    const value = env[name]
    if (value !== undefined) passed[name] = value
  }
  if (paths) passed[MEDIA_ROOTS_VARIABLE] = paths.outbox
  return passed
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first executable `wacli` on `env.PATH`, else in the usual package manager prefixes; `not_found` when there is none. */
export async function findWacli(env: Record<string, string | undefined>): Promise<string> {
  const onPath = (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "")
  for (const dir of [...onPath, ...FALLBACK_DIRS]) {
    const candidate = join(dir, PROGRAM_NAME)
    if (await isExecutableFile(candidate)) return candidate
  }
  throw new ToolError("not_found", NOT_INSTALLED)
}

type Version = [number, number, number]

/** The numbers in the first `major.minor.patch` of `text`, or null when there is none. */
export function parseVersion(text: string): Version | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function isOlder(version: Version, than: Version): boolean {
  for (const [index, part] of version.entries()) {
    if (part !== than[index]) return part < than[index]!
  }
  return false
}

/** Runs a program, with a program that cannot be started thrown as a `ToolError` and an abort left as it is. */
async function execProgram(argv: string[], options: ExecOptions): Promise<ExecResult> {
  try {
    return await exec(argv, options)
  } catch (error) {
    if (isAbortError(error)) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") throw new ToolError("not_found", NOT_INSTALLED, { cause: error })
    if (typeof code === "string") {
      throw new ToolError("upstream_error", `${PROGRAM_NAME} could not be started (${code}).`, { cause: error })
    }
    throw error
  }
}

/**
 * Finds wacli and asks it for its version, once per program path for the life of the process. Throws
 * `upstream_error` for a version older than `WACLI_MIN_VERSION` or one that cannot be read.
 */
export async function checkWacli(
  env: Record<string, string | undefined>,
  options: { signal?: AbortSignal } = {},
): Promise<WacliInfo> {
  const program = await findWacli(env)
  const known = checked.get(program)
  if (known) return known

  const result = await execProgram([program, "version"], {
    env: wacliEnv(env),
    signal: options.signal,
    timeoutMs: VERSION_TIMEOUT_MS,
  })
  const parsed = result.code === 0 && !result.timedOut ? parseVersion(result.stdout) : null
  if (!parsed) {
    const printed = maskNumbers(result.stdout).trim().slice(0, MAX_DETAIL_LENGTH)
    throw new ToolError(
      "upstream_error",
      `Could not read wacli's version${printed ? ` (it printed: ${printed})` : ""}; these tools need wacli ${WACLI_MIN_VERSION} or later (${WACLI_URL}).`,
    )
  }
  const version = parsed.join(".")
  const minimum = parseVersion(WACLI_MIN_VERSION)!
  if (isOlder(parsed, minimum)) throw new WacliTooOldError(version)
  const info = { program, version }
  checked.set(program, info)
  return info
}

/** The arguments for wacli on one label's store, followed by `args`; `--read-only` only when `readOnly`. */
export function wacliArgs(paths: LabelPaths, args: string[], { readOnly }: { readOnly: boolean }): string[] {
  return ["--store", paths.store, "--json", ...(readOnly ? ["--read-only"] : []), ...args]
}

function parseEnvelope(line: string): Envelope | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) && typeof parsed.success === "boolean" ? (parsed as Envelope) : undefined
  } catch {
    return undefined
  }
}

/** The envelope in wacli's output: the whole text, else the last line that is one. Other lines are status text. */
export function readEnvelope(text: string): Envelope | undefined {
  const trimmed = text.trim()
  const whole = parseEnvelope(trimmed)
  if (whole) return whole
  for (const line of trimmed.split("\n").reverse()) {
    const envelope = parseEnvelope(line.trim())
    if (envelope) return envelope
  }
  return undefined
}

/** The text of the failure envelope wacli wrote, or undefined when it wrote none. */
function failureText(result: ExecResult): string | undefined {
  for (const text of [result.stderr, result.stdout]) {
    const envelope = readEnvelope(text)
    if (envelope && !envelope.success) return typeof envelope.error === "string" ? envelope.error : ""
  }
  return undefined
}

function unknownOutcome(mode: WacliMode, what: string, advice = ""): ToolError {
  return mode === "write"
    ? new ToolError("uncertain", `${what}, so the change may have taken effect. ${UNCERTAIN_ADVICE}${advice}`)
    : new ToolError("upstream_error", `${what}.${advice}`)
}

function unreadable(mode: WacliMode, what: string, stderr: string): ToolError {
  const tail = maskNumbers(stderr).trim().slice(-MAX_DETAIL_LENGTH)
  return unknownOutcome(mode, `wacli ${what}`, tail ? ` Its last output: ${tail}` : "")
}

function failureError(text: string, mode: WacliMode): ToolError {
  const detail = maskNumbers(text).trim().slice(0, MAX_DETAIL_LENGTH)
  if (REFUSED.test(text.trim())) return new ToolError("invalid_argument", `wacli refused the call: ${detail}`)
  if (NOT_AUTHENTICATED.test(text)) {
    return new ToolError("unauthenticated", "No WhatsApp device is paired for this account; pair the device first.")
  }
  if (SESSION_ENDED.test(text)) {
    return new ToolError(
      "unauthenticated",
      `WhatsApp revoked this account's session (${detail}); pair the device again.`,
    )
  }
  if (STORE_LOCKED.test(text)) {
    return new ToolError(
      "upstream_error",
      "The account's store is held by another wacli process, normally its sync service; a call that needs the store must go through the service.",
    )
  }
  return unknownOutcome(mode, `wacli reported an error (${detail || "no message"})`)
}

/**
 * The error for a wacli call that did not succeed: by the text of the envelope wacli wrote on failure, since
 * wacli exits with 0 or 1 only. A call whose outcome is unknown is `upstream_error` for a read or an ask and
 * `uncertain` for a write. `timeoutMs` is the limit the call ran under.
 */
export function wacliError(result: ExecResult, mode: WacliMode, timeoutMs = DEFAULT_TIMEOUT_MS): ToolError {
  if (result.timedOut) return unknownOutcome(mode, `wacli did not answer within ${timeoutMs / 1000} s`)
  if (result.signal) return unreadable(mode, `ended on ${result.signal}`, result.stderr)
  const text = failureText(result)
  if (text !== undefined) return failureError(text, mode)
  const what =
    result.code === 0 ? "printed output that is not a result" : `exited with code ${result.code} without a result`
  return unreadable(mode, what, result.stderr)
}

/**
 * Runs wacli on one label's store and returns the `data` of its envelope. Only a `read` runs with `--read-only`. Failures
 * throw as `wacliError` says; an abort rejects with the `AbortError` untouched.
 */
export async function runWacli(paths: LabelPaths, args: string[], options: WacliRunOptions): Promise<unknown> {
  const { env, mode, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const { program } = await checkWacli(env, { signal })
  const result = await execProgram([program, ...wacliArgs(paths, args, { readOnly: mode === "read" })], {
    env: wacliEnv(env, paths),
    signal,
    timeoutMs,
  })
  if (result.code === 0 && !result.timedOut && !result.signal) {
    const envelope = readEnvelope(result.stdout)
    // wacli always writes `data` on success; an envelope without it is output that cannot be read.
    if (envelope?.success && "data" in envelope) return envelope.data
  }
  throw wacliError(result, mode, timeoutMs)
}
