import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { CHAT_JID_FORM } from "./backfill"
import { MESSAGE_ID_FORM } from "./media"
import {
  LONE_SURROGATE,
  acceptedOf,
  commonNotSent,
  sentOf,
  type SendAnswer,
  type SendOutcomeOptions,
} from "./send-outcome"
import type { ServiceOperationContext } from "./service-socket"
import { execWacli } from "./wacli"

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

/** wacli's text for a recipient that is the linked account itself. */
const OWN_ACCOUNT = /^send text to the linked account itself is not supported/i

/** wacli's text when the recipient or the text is missing. */
const MISSING_ARGUMENT = /^--to and --message are required/i

/** The chat a send or an action names, as the service takes it: a JID, never a channel, a broadcast list or the status feed, whoever asks. */
export const reachableChat = z
  .string()
  .regex(CHAT_JID_FORM)
  .refine((chat) => !/@(?:newsletter|broadcast)$/.test(chat))

/** One message's text, as the service takes it: 1 to `MESSAGE_TEXT_MAX_CHARACTERS` code points, none of them half a character. */
export const messageText = z
  .string()
  .min(1)
  .refine((text) => [...text].length <= MESSAGE_TEXT_MAX_CHARACTERS && !LONE_SURROGATE.test(text))

/** The arguments of `message_send`. */
const sendArguments = z.strictObject({
  chat: reachableChat,
  text: messageText,
  reply_to: z.string().regex(MESSAGE_ID_FORM).optional(),
})

/** What wacli prints for a text it sent: `sent`, and the id WhatsApp gave the message. */
const sentText = z.object({
  sent: z.literal(true),
  id: z.string().min(1),
  store_warning: z.string().optional(),
})

/** The error for a wacli text that says the request ended before anything was sent, else undefined. */
function notSent(text: string): ToolError | undefined {
  const known = commonNotSent(text)
  if (known) return known
  if (OWN_ACCOUNT.test(text)) {
    return new ToolError(
      "invalid_argument",
      "A text to the account's own chat is refused: WhatsApp can accept it without delivering it. Use the official Message Yourself chat on the phone. Nothing was sent.",
    )
  }
  if (MISSING_ARGUMENT.test(text)) {
    return new ToolError("invalid_argument", "wacli was given no recipient or no text. Nothing was sent.")
  }
  return undefined
}

/** How the failures of a text send are told. */
const OUTCOME: SendOutcomeOptions = {
  subject: "message",
  processLimitMs: MESSAGE_SEND_PROCESS_LIMIT_MS,
  notSent,
}

/** The answer of a send that succeeded, else the error it ended with; a success that proves no send is `uncertain`. */
function answerOf(result: ExecResult): SendAnswer {
  const sent = sentOf(result, sentText, OUTCOME)
  return acceptedOf(sent.id, sent.store_warning)
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
