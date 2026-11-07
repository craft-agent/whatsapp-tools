import { MASK, maskNumbers } from "./mask"

/** The event after which wacli ends its sync with exit 0 because WhatsApp ended the session. */
export const LOGGED_OUT_EVENT = "logged_out"

/** The event that says wacli is connected to WhatsApp. */
export const CONNECTED_EVENT = "connected"

/** Events that come in bursts; the status file does not record each one. */
export const FREQUENT_EVENTS: ReadonlySet<string> = new Set(["progress", "history_sync"])

/** One event wacli reported on its standard error with `--events`. */
export type WacliEvent = { name: string; data: Record<string, unknown> }

/** What an event's name looks like; anything else is not logged as an event. */
const EVENT_NAME = /^[a-z][a-z0-9_]{0,39}$/

/** The fields of an event that the log may carry as text: they name a state, never a person or a chat. */
const TEXT_FIELDS: ReadonlySet<string> = new Set(["reason", "state", "status", "kind", "type", "mode"])

/** What a harmless text value looks like. */
const SAFE_TEXT = /^[A-Za-z0-9 _.:-]{1,60}$/

/** A whole number below this is a count or a percentage; a larger one may be a time or a number worth masking. */
const MAX_LOGGED_NUMBER = 100_000

/** A JSON string literal, or the mask. */
const STRING_OR_MASK = new RegExp(String.raw`"(?:[^"\\]|\\.)*"|${MASK}`, "g")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The event on a line of wacli's standard error, or undefined for any other line. The line may be masked already,
 * which turns a bare number of six or more digits (the event's time) into the mask; the mask is read as null there.
 */
export function parseEvent(line: string): WacliEvent | undefined {
  if (!line.startsWith("{")) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line.replace(STRING_OR_MASK, (match) => (match === MASK ? "null" : match)))
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.event !== "string" || !EVENT_NAME.test(parsed.event)) return undefined
  return { name: parsed.event, data: isRecord(parsed.data) ? parsed.data : {} }
}

function harmlessValue(key: string, value: unknown): string | undefined {
  if (typeof value === "boolean") return String(value)
  if (typeof value === "number")
    return Number.isInteger(value) && Math.abs(value) < MAX_LOGGED_NUMBER ? String(value) : undefined
  if (typeof value === "string" && TEXT_FIELDS.has(key) && SAFE_TEXT.test(value)) return value.replaceAll(" ", "_")
  return undefined
}

/** The log line for an event: `event <name>` and the fields that name no person, chat or number, masked once more. */
export function describeEvent({ name, data }: WacliEvent): string {
  const fields: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) continue
    const text = harmlessValue(key, value)
    if (text !== undefined) fields.push(`${key}=${text}`)
  }
  return maskNumbers(["event", name, ...fields].join(" "))
}
