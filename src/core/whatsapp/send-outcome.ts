import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { maskNumbers } from "./mask"
import { failureText, readEnvelope, wacliError } from "./wacli"

/** How much of wacli's own text an error carries. */
const MAX_DETAIL_LENGTH = 300

/** Half of a character, which cannot reach wacli's command line as it is: it would arrive as a replacement character. */
export const LONE_SURROGATE = /[\uD800-\uDFFF]/u

/** wacli's texts for a send that may have gone out after all; they override every other text. */
const MAY_HAVE_GONE_THROUGH = /may still have gone through|no reply from the running sync process/i

/** wacli's texts for a request it dropped from its send queue before it was dispatched. */
const NOT_DISPATCHED = /before dispatch; it was not sent/i

/** wacli's text when the message to quote is not in the store the sync holds. */
const QUOTE_NOT_STORED = /^quoted message \S+ not found in local store/i

/** wacli's texts for a quote it cannot build from the message, which it says before it sends anything. */
const QUOTE_REFUSED =
  /^(?:cannot quote message|stored quoted sender is invalid|invalid --reply-to-sender|--reply-to-sender is required|linked account (?:JID|LID) is unavailable)/i

/** wacli's texts for a quote it could not look up (its store or WhatsApp failed), said before it sends anything. */
const QUOTE_LOOKUP_FAILED = /^(?:lookup quoted message|get group info for quoted outgoing message)/i

/**
 * wacli's texts the runner's mapping reads as nothing sent (a refused call, no paired device, a revoked session, a
 * store held elsewhere), when they open the error. The same words later in it, such as after a retry that failed
 * to reconnect, come after the send may have left, so they say nothing of it.
 */
const GENERIC_NOT_SENT =
  /^(?:error:\s*)?(?:read-only mode:|unknown (?:flag|command|shorthand flag)|required flag|invalid argument|accepts \d+ arg|not authenticated|(?:whatsapp )?session was revoked|(?:whatsapp )?login failed|store is locked|timed out waiting for store lock)/i

/** What `message_send` and `file_send` return: the id WhatsApp gave the message, when wacli reported it accepted (in milliseconds), and what wacli said when it could not write the message to the mirror. */
export const sendAnswer = z.object({
  id: z.string().min(1),
  accepted_ms: z.number().int().nonnegative(),
  store_warning: z.string().min(1).optional(),
})

/** What wacli reported of a send WhatsApp accepted. */
export type SendAnswer = z.infer<typeof sendAnswer>

/** The part of a send that differs between what is sent: how its failures are told, and what they are about. */
export type SendOutcomeOptions = {
  /** What is sent, as the messages name it: `message` or `file`. */
  subject: string
  /** How long the wacli process ran under, for the message of a time-out. */
  processLimitMs: number
  /** The error for a wacli text that says the request ended before anything was sent, else undefined. */
  notSent(text: string): ToolError | undefined
}

/** The text of wacli's own error, with the numbers masked and cut to what an error carries. */
export function detailOf(text: string): string {
  return maskNumbers(text).trim().slice(0, MAX_DETAIL_LENGTH)
}

/** The error for a wacli text that says its send queue dropped a request for `subject` (an `edit`, …) before dispatching it, else undefined. */
export function notDispatched(text: string, subject: string): ToolError | undefined {
  if (!NOT_DISPATCHED.test(text)) return undefined
  return new ToolError(
    "upstream_error",
    `WhatsApp did not get the ${subject}: wacli's send queue dropped it before it was dispatched (${detailOf(text)}). Nothing was changed; trying again is safe.`,
  )
}

/** The error for a wacli text of a quote or a queue that says the request ended before anything was sent, else undefined. */
export function commonNotSent(text: string): ToolError | undefined {
  if (NOT_DISPATCHED.test(text)) {
    return new ToolError(
      "upstream_error",
      `WhatsApp did not get the message: wacli's send queue dropped it before it was dispatched (${detailOf(text)}). Nothing was sent; sending again is safe.`,
    )
  }
  if (QUOTE_NOT_STORED.test(text)) {
    return new ToolError(
      "not_found",
      "The message to reply to is not in the local store of the sync service, so it cannot be quoted. Nothing was sent.",
    )
  }
  if (QUOTE_REFUSED.test(text)) {
    return new ToolError(
      "invalid_argument",
      `wacli could not quote the message (${detailOf(text)}). Nothing was sent; send without reply_to or quote another message.`,
    )
  }
  if (QUOTE_LOOKUP_FAILED.test(text)) {
    return new ToolError(
      "upstream_error",
      `wacli could not look up the message to quote (${detailOf(text)}). Nothing was sent; sending again is safe.`,
    )
  }
  return undefined
}

/** The error for a send that failed: `uncertain` for any text that says it may have gone through, whatever else it says. */
export function failureOf(result: ExecResult, { subject, processLimitMs, notSent }: SendOutcomeOptions): ToolError {
  const text = result.timedOut || result.signal ? undefined : failureText(result)
  if (text === undefined) return wacliError(result, "write", processLimitMs)
  if (MAY_HAVE_GONE_THROUGH.test(text)) {
    return new ToolError(
      "uncertain",
      `wacli could not tell whether the ${subject} went out (${detailOf(text)}), so it may have been sent. Check before trying again.`,
    )
  }
  const known = notSent(text)
  if (known) return known
  if (GENERIC_NOT_SENT.test(text.trim())) return wacliError(result, "write", processLimitMs)
  return new ToolError(
    "uncertain",
    `wacli reported an error (${detailOf(text) || "no message"}), so the ${subject} may have been sent. Check before trying again.`,
  )
}

/** What wacli printed for a send that succeeded, as `sent` reads it, else the error it ended with; a success that proves no send is `uncertain`. */
export function sentOf<S extends z.ZodType>(result: ExecResult, sent: S, options: SendOutcomeOptions): z.output<S> {
  if (result.code === 0 && !result.timedOut && !result.signal) {
    const envelope = readEnvelope(result.stdout)
    if (envelope?.success && "data" in envelope) {
      const parsed = sent.safeParse(envelope.data)
      if (!parsed.success) {
        throw new ToolError(
          "uncertain",
          `wacli reported success without saying the ${options.subject} was sent, so it may have been. Check before trying again.`,
        )
      }
      return parsed.data
    }
  }
  throw failureOf(result, options)
}

/** The answer for a send WhatsApp accepted just now, with wacli's `warning` for the mirror when it gave one. */
export function acceptedOf(id: string, warning: string | undefined): SendAnswer {
  return { id, accepted_ms: Date.now(), ...(warning ? { store_warning: detailOf(warning) } : {}) }
}
