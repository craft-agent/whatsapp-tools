import type { ErrorCode } from "../errors"

/**
 * One request on the sync service's socket, as one line of JSON ending in a line break. `deadline_ms` is how long
 * the caller will wait, in whole milliseconds counted from the request's arrival; a request still queued when it
 * passes is not run.
 */
export type ServiceRequest = { op: string; args?: unknown; deadline_ms?: number }

/** The one line of JSON the service answers with before it closes the connection. */
export type ServiceResponse = { ok: true; data: unknown } | { ok: false; error: { code: ErrorCode; message: string } }

/** The longest deadline a request may carry: 24 hours. */
export const MAX_DEADLINE_MS = 86_400_000

/** Every error code, kept exhaustive by its type. */
const ERROR_CODES: Record<ErrorCode, true> = {
  not_found: true,
  forbidden: true,
  invalid_argument: true,
  stale: true,
  unauthenticated: true,
  rate_limited: true,
  declined: true,
  upstream_error: true,
  uncertain: true,
  internal_error: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** The response that fails with `code`. */
export function failureResponse(code: ErrorCode, message: string): ServiceResponse {
  return { ok: false, error: { code, message } }
}

/** A request or a response as one line, with its line break. */
export function encodeLine(message: ServiceRequest | ServiceResponse): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * The request on a line, or undefined when it is not one: JSON with a non-empty `op` and, if any, a `deadline_ms`
 * that is a whole number of milliseconds from 1 to `MAX_DEADLINE_MS`.
 */
export function parseRequest(line: string): ServiceRequest | undefined {
  const parsed = parseJson(line)
  if (!isRecord(parsed) || typeof parsed.op !== "string" || parsed.op === "") return undefined
  const { deadline_ms } = parsed
  if (
    deadline_ms !== undefined &&
    !(
      typeof deadline_ms === "number" &&
      Number.isSafeInteger(deadline_ms) &&
      deadline_ms > 0 &&
      deadline_ms <= MAX_DEADLINE_MS
    )
  ) {
    return undefined
  }
  return { op: parsed.op, args: parsed.args, ...(deadline_ms !== undefined ? { deadline_ms } : {}) }
}

/** The response on a line, or undefined when it is not one. */
export function parseResponse(line: string): ServiceResponse | undefined {
  const parsed = parseJson(line)
  if (!isRecord(parsed)) return undefined
  if (parsed.ok === true) return { ok: true, data: parsed.data }
  if (parsed.ok !== false || !isRecord(parsed.error)) return undefined
  const { code, message } = parsed.error
  if (typeof code !== "string" || !Object.hasOwn(ERROR_CODES, code) || typeof message !== "string") return undefined
  return failureResponse(code as ErrorCode, message)
}
