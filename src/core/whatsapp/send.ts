import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { CHAT_JID_FORM } from "./backfill"
import { maskNumbers } from "./mask"
import { MESSAGE_ID_FORM } from "./media"
import type { ServiceOperationContext } from "./service-socket"
import { execWacli, failureText, readEnvelope, wacliError } from "./wacli"

/** The name of the service operation that sends one text. */
export const MESSAGE_SEND_OP = "message_send"

/** The most characters one text has, counted as code points. */
export const MESSAGE_TEXT_MAX_CHARACTERS = 4000

/** How long a send may take in all, which is the deadline its caller gives the service. */
export const MESSAGE_SEND_DEADLINE_MS = 90_000

/** How long wacli itself may take for it (its `--timeout`), so that its own time-out is what is reported. */
const MESSAGE_SEND_WACLI_TIMEOUT_MS = 60_000

/** How long the process may run before it is killed: past wacli's own time-out, within the service's deadline. */
const MESSAGE_SEND_PROCESS_LIMIT_MS = 75_000

/** Half of a character, which cannot reach wacli's command line as it is: it would arrive as a replacement character. */
export const LONE_SURROGATE = /[\uD800-\uDFFF]/u

/** How much of wacli's own text an error carries. */
const MAX_DETAIL_LENGTH = 300

/** wacli's text for a send that may have gone out after all; it overrides every other text. */
const MAY_HAVE_GONE_THROUGH = /may still have gone through/i

/** wacli's texts for a request it dropped from its send queue before it was dispatched. */
const NOT_DISPATCHED = /before dispatch; it was not sent/i

/** wacli's text for a recipient that is the linked account itself. */
const OWN_ACCOUNT = /^send text to the linked account itself is not supported/i

/** wacli's text when the message to quote is not in the store the sync holds. */
const QUOTE_NOT_STORED = /^quoted message \S+ not found in local store/i

/** wacli's texts for a quote it cannot build from the message, which it says before it sends anything. */
const QUOTE_REFUSED =
  /^(?:cannot quote message|stored quoted sender is invalid|invalid --reply-to-sender|--reply-to-sender is required|linked account (?:JID|LID) is unavailable)/i

/** wacli's texts for a quote it could not look up (its store or WhatsApp failed), said before it sends anything. */
const QUOTE_LOOKUP_FAILED = /^(?:lookup quoted message|get group info for quoted outgoing message)/i

/** wacli's text when the recipient or the text is missing. */
const MISSING_ARGUMENT = /^--to and --message are required/i

/**
 * wacli's texts the runner's mapping reads as nothing sent (a refused call, no paired device, a revoked session, a
 * store held elsewhere), when they open the error. The same words later in it, such as after a retry that failed
 * to reconnect, come after the send may have left, so they say nothing of it.
 */
const GENERIC_NOT_SENT =
  /^(?:error:\s*)?(?:read-only mode:|unknown (?:flag|command|shorthand flag)|required flag|invalid argument|accepts \d+ arg|not authenticated|(?:whatsapp )?session was revoked|(?:whatsapp )?login failed|store is locked|timed out waiting for store lock)/i

/** The arguments of `message_send`. */
const sendArguments = z.strictObject({
  // A channel, a broadcast list and the status feed are refused here too, whoever asks.
  chat: z
    .string()
    .regex(CHAT_JID_FORM)
    .refine((chat) => !/@(?:newsletter|broadcast)$/.test(chat)),
  text: z
    .string()
    .min(1)
    .refine((text) => [...text].length <= MESSAGE_TEXT_MAX_CHARACTERS && !LONE_SURROGATE.test(text)),
  reply_to: z.string().regex(MESSAGE_ID_FORM).optional(),
})

/** What wacli prints for a text it sent: `sent`, and the id WhatsApp gave the message. */
const sentText = z.object({
  sent: z.literal(true),
  id: z.string().min(1),
  store_warning: z.string().optional(),
})

/** What `message_send` returns: the id WhatsApp gave the message, when wacli reported it accepted (in milliseconds), and what wacli said when it could not write the message to the mirror. */
export const sendAnswer = z.object({
  id: z.string().min(1),
  accepted_ms: z.number().int().nonnegative(),
  store_warning: z.string().min(1).optional(),
})

/** What wacli reported of a text WhatsApp accepted. */
export type SendAnswer = z.infer<typeof sendAnswer>

function detailOf(text: string): string {
  return maskNumbers(text).trim().slice(0, MAX_DETAIL_LENGTH)
}

/** The error for a wacli text that says the request ended before anything was sent, else undefined. */
function notSent(text: string): ToolError | undefined {
  if (NOT_DISPATCHED.test(text)) {
    return new ToolError(
      "upstream_error",
      `WhatsApp did not get the message: wacli's send queue dropped it before it was dispatched (${detailOf(text)}). Nothing was sent; sending again is safe.`,
    )
  }
  if (OWN_ACCOUNT.test(text)) {
    return new ToolError(
      "invalid_argument",
      "A text to the account's own chat is refused: WhatsApp can accept it without delivering it. Use the official Message Yourself chat on the phone. Nothing was sent.",
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
  if (MISSING_ARGUMENT.test(text)) {
    return new ToolError("invalid_argument", "wacli was given no recipient or no text. Nothing was sent.")
  }
  return undefined
}

/** The error for a send that failed: `uncertain` for any text that says it may have gone through, whatever else it says. */
function failureOf(result: ExecResult): ToolError {
  const text = result.timedOut || result.signal ? undefined : failureText(result)
  if (text === undefined) return wacliError(result, "write", MESSAGE_SEND_PROCESS_LIMIT_MS)
  if (MAY_HAVE_GONE_THROUGH.test(text)) {
    return new ToolError(
      "uncertain",
      `wacli could not tell whether the message went out (${detailOf(text)}), so it may have been sent. Check before trying again.`,
    )
  }
  const known = notSent(text)
  if (known) return known
  if (GENERIC_NOT_SENT.test(text.trim())) return wacliError(result, "write", MESSAGE_SEND_PROCESS_LIMIT_MS)
  return new ToolError(
    "uncertain",
    `wacli reported an error (${detailOf(text) || "no message"}), so the message may have been sent. Check before trying again.`,
  )
}

/** The answer of a send that succeeded, else the error it ended with; a success that proves no send is `uncertain`. */
function answerOf(result: ExecResult): SendAnswer {
  if (result.code === 0 && !result.timedOut && !result.signal) {
    const envelope = readEnvelope(result.stdout)
    if (envelope?.success && "data" in envelope) {
      const sent = sentText.safeParse(envelope.data)
      if (!sent.success) {
        throw new ToolError(
          "uncertain",
          "wacli reported success without saying the message was sent, so it may have been. Check before trying again.",
        )
      }
      const warning = sent.data.store_warning
      return { id: sent.data.id, accepted_ms: Date.now(), ...(warning ? { store_warning: detailOf(warning) } : {}) }
    }
  }
  throw failureOf(result)
}

/**
 * Sends one text through the running sync: wacli runs without `--read-only`, so it hands the send to the sync, which
 * holds the store. No link preview is built, and the quote is made of the message `reply_to` names. A failure known to
 * have happened before anything left keeps its code; every other failure is `uncertain`, since the message may have
 * gone out.
 */
export async function sendText(args: unknown, { paths, env, signal }: ServiceOperationContext): Promise<SendAnswer> {
  const parsed = sendArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError(
      "invalid_argument",
      `message_send takes chat (a JID), text (1 to ${MESSAGE_TEXT_MAX_CHARACTERS} characters) and reply_to (a message id, optional).`,
    )
  }
  const { chat, text, reply_to: replyTo } = parsed.data
  const result = await execWacli(
    paths,
    [
      "send",
      "text",
      "--timeout",
      `${MESSAGE_SEND_WACLI_TIMEOUT_MS / 1000}s`,
      "--to",
      chat,
      "--message",
      text,
      "--no-preview",
      ...(replyTo === undefined ? [] : ["--reply-to", replyTo]),
    ],
    { env, mode: "write", signal, timeoutMs: MESSAGE_SEND_PROCESS_LIMIT_MS },
  )
  return answerOf(result)
}
