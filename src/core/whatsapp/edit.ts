import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { MESSAGE_ID_FORM } from "./media"
import { detailOf, notDispatched, sentOf, type SendOutcomeOptions } from "./send-outcome"
import { MESSAGE_TEXT_MAX_CHARACTERS, messageText, reachableChat } from "./send"
import type { ServiceOperationContext } from "./service-socket"
import { execWacli, failureText } from "./wacli"

/** The name of the service operation that edits the text of one message. */
export const MESSAGE_EDIT_OP = "message_edit"

/** How long an edit may take in all, which is the deadline its caller gives the service. */
export const MESSAGE_EDIT_DEADLINE_MS = 90_000

/** How long wacli itself may take for it (its `--timeout`), so that its own time-out is what is reported. */
const MESSAGE_EDIT_WACLI_TIMEOUT_MS = 60_000

/** How long the process may run before it is killed: past wacli's own time-out, within the service's deadline. */
const MESSAGE_EDIT_PROCESS_LIMIT_MS = 75_000

/** wacli's text when it accepted the edit at WhatsApp but could not write the new text to the mirror. */
const STORE_FAILED = /^store edited message text/i

/** wacli's text when the message is not one the user sent. */
export const NOT_OWN_MESSAGE = /^message \S+ was not sent by me/i

/** wacli's texts when the message is deleted, for everyone or for the user. */
export const DELETED_MESSAGE = /^message \S+ (?:is already deleted|was deleted for me)/i

/** wacli's text for a message that is not text. */
const NOT_TEXT_MESSAGE = /^only text messages can be edited/i

/** wacli's text for a message older than the window it knows. */
const PAST_EDIT_WINDOW = /^message \S+ is older than whatsapp's .+ edit window/i

/** wacli's text when the chat, the message id or the new text is missing. */
const MISSING_ARGUMENT = /^--chat, --id, and --message are required/i

/** wacli's text when the sync's store holds no such message. */
export const NO_SUCH_MESSAGE = /^sql: no rows in result set/i

/** The arguments of `message_edit`. */
const editArguments = z.strictObject({
  chat: reachableChat,
  id: z.string().regex(MESSAGE_ID_FORM),
  text: messageText,
})

/** What wacli prints for an edit it made: `edited`, beside the ids it names. */
const editedText = z.object({ edited: z.literal(true) })

/** What `message_edit` returns: when wacli reported the edit accepted (in milliseconds), and what wacli said when it could not write the new text to the mirror. */
export const editAnswer = z.object({
  accepted_ms: z.number().int().nonnegative(),
  store_warning: z.string().min(1).optional(),
})

/** What wacli reported of an edit WhatsApp accepted. */
export type EditAnswer = z.infer<typeof editAnswer>

/** The error for a wacli text that says the request ended before anything was changed, else undefined. */
function notSent(text: string): ToolError | undefined {
  const known = notDispatched(text, "edit")
  if (known) return known
  if (NOT_OWN_MESSAGE.test(text)) {
    return new ToolError("forbidden", "Only the user's own messages can be edited. Nothing was changed.")
  }
  if (DELETED_MESSAGE.test(text)) {
    return new ToolError("not_found", "The message was deleted, so it cannot be edited. Nothing was changed.")
  }
  if (NOT_TEXT_MESSAGE.test(text)) {
    return new ToolError("invalid_argument", "Only text messages can be edited. Nothing was changed.")
  }
  if (PAST_EDIT_WINDOW.test(text)) {
    return new ToolError(
      "forbidden",
      "The message is too old to be edited, past WhatsApp's limit. Nothing was changed.",
    )
  }
  if (MISSING_ARGUMENT.test(text)) {
    return new ToolError("invalid_argument", "wacli was given no chat, no message id or no text. Nothing was changed.")
  }
  if (NO_SUCH_MESSAGE.test(text)) {
    return new ToolError("not_found", "The message is not in the local store of the sync service. Nothing was changed.")
  }
  return undefined
}

/** How the failures of an edit are told. */
const OUTCOME: SendOutcomeOptions = {
  subject: "edit",
  processLimitMs: MESSAGE_EDIT_PROCESS_LIMIT_MS,
  notSent,
}

/** What wacli said of writing the mirror, when it failed only there after WhatsApp accepted the edit, else undefined. */
function storeWarningOf(result: ExecResult): string | undefined {
  if (result.code === 0 || result.timedOut || result.signal) return undefined
  const text = failureText(result)?.trim()
  return text !== undefined && STORE_FAILED.test(text) ? detailOf(text) : undefined
}

/** The answer of an edit that succeeded, else the error it ended with; a success that proves no edit is `uncertain`. */
function answerOf(result: ExecResult): EditAnswer {
  const storeWarning = storeWarningOf(result)
  if (storeWarning !== undefined) return { accepted_ms: Date.now(), store_warning: storeWarning }
  sentOf(result, editedText, OUTCOME)
  return { accepted_ms: Date.now() }
}

/**
 * Edits one text through the running sync: wacli runs without `--read-only`, so it hands the edit to the sync, which
 * holds the store. A failure known to have happened before anything left keeps its code; every other failure is
 * `uncertain`, since the edit may have gone out. A failure of writing the new text to the mirror alone is a success
 * that carries wacli's warning, since WhatsApp has the edit.
 */
export async function editMessage(args: unknown, { paths, env, signal }: ServiceOperationContext): Promise<EditAnswer> {
  const parsed = editArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError(
      "invalid_argument",
      `message_edit takes chat (a JID), id (a message id) and text (1 to ${MESSAGE_TEXT_MAX_CHARACTERS} characters).`,
    )
  }
  const { chat, id, text } = parsed.data
  const result = await execWacli(
    paths,
    [
      "messages",
      "edit",
      "--timeout",
      `${MESSAGE_EDIT_WACLI_TIMEOUT_MS / 1000}s`,
      "--chat",
      chat,
      "--id",
      id,
      "--message",
      text,
    ],
    { env, mode: "write", signal, timeoutMs: MESSAGE_EDIT_PROCESS_LIMIT_MS },
  )
  return answerOf(result)
}
