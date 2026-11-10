import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { isOneEmoji } from "../message/emoji"
import { CHAT_JID_FORM } from "./backfill"
import { MESSAGE_ID_FORM } from "./media"
import { detailOf, notDispatched, sentOf, type SendOutcomeOptions } from "./send-outcome"
import { reachableChat } from "./send"
import type { ServiceOperationContext } from "./service-socket"
import { execWacli } from "./wacli"

/** The name of the service operation that reacts to one message, or removes a reaction. */
export const MESSAGE_REACT_OP = "message_react"

/** How long a reaction may take in all, which is the deadline its caller gives the service. */
export const MESSAGE_REACT_DEADLINE_MS = 90_000

/** How long wacli itself may take for it (its `--timeout`), so that its own time-out is what is reported. */
const MESSAGE_REACT_WACLI_TIMEOUT_MS = 60_000

/** How long the process may run before it is killed: past wacli's own time-out, within the service's deadline. */
const MESSAGE_REACT_PROCESS_LIMIT_MS = 75_000

/** wacli's text when the chat or the message id is missing. */
const MISSING_ARGUMENT = /^--to and --id are required/i

/** wacli's texts for a chat or a sender it cannot read as a JID, or a group reaction with no sender. */
const BAD_TARGET = /^(?:--sender is required for group reactions|invalid --sender|invalid --to)/i

/** The arguments of `message_react`: `reaction` is one emoji, or empty to remove the user's reaction. */
const reactArguments = z.strictObject({
  chat: reachableChat,
  id: z.string().regex(MESSAGE_ID_FORM),
  reaction: z.string().refine((reaction) => reaction === "" || isOneEmoji(reaction)),
  sender: z.string().regex(CHAT_JID_FORM).optional(),
})

/** What wacli prints for a reaction it sent: `sent`, beside the ids it names, and its warning when it could not write the mirror. */
const reactedText = z.object({
  sent: z.literal(true),
  store_warning: z.string().optional(),
})

/** What `message_react` returns: when wacli reported the reaction accepted (in milliseconds), and what wacli said when it could not write it to the mirror. */
export const reactAnswer = z.object({
  accepted_ms: z.number().int().nonnegative(),
  store_warning: z.string().min(1).optional(),
})

/** What wacli reported of a reaction WhatsApp accepted. */
export type ReactAnswer = z.infer<typeof reactAnswer>

/** The error for a wacli text that says the request ended before anything was sent, else undefined. */
function notSent(text: string): ToolError | undefined {
  const known = notDispatched(text, "reaction")
  if (known) return known
  if (MISSING_ARGUMENT.test(text)) {
    return new ToolError("invalid_argument", "wacli was given no chat or no message id. Nothing was changed.")
  }
  if (BAD_TARGET.test(text)) {
    return new ToolError(
      "invalid_argument",
      "wacli could not address the message: the chat or the sender is not a JID it reads, or a group message came with no sender. Nothing was changed.",
    )
  }
  return undefined
}

/** How the failures of a reaction are told. */
const OUTCOME: SendOutcomeOptions = {
  subject: "reaction",
  processLimitMs: MESSAGE_REACT_PROCESS_LIMIT_MS,
  notSent,
}

/** The answer of a reaction that succeeded, else the error it ended with; a success that proves no reaction is `uncertain`. */
function answerOf(result: ExecResult): ReactAnswer {
  const { store_warning: warning } = sentOf(result, reactedText, OUTCOME)
  return { accepted_ms: Date.now(), ...(warning ? { store_warning: detailOf(warning) } : {}) }
}

/**
 * Reacts to one message through the running sync, or removes the user's reaction with an empty `reaction`: wacli runs
 * without `--read-only`, so it hands the reaction to the sync, which holds the store. `sender` is the author of the
 * message, which WhatsApp needs to address it; wacli requires it in a group. A failure known to have happened before
 * anything left keeps its code; every other failure is `uncertain`, since the reaction may have gone out. A failure
 * of writing the reaction to the mirror alone is a success that carries wacli's warning.
 */
export async function reactToMessage(
  args: unknown,
  { paths, env, signal }: ServiceOperationContext,
): Promise<ReactAnswer> {
  const parsed = reactArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError(
      "invalid_argument",
      "message_react takes chat (a JID), id (a message id), reaction (one emoji, or empty to remove it) and sender (a JID, optional).",
    )
  }
  const { chat, id, reaction, sender } = parsed.data
  const result = await execWacli(
    paths,
    [
      "send",
      "react",
      "--timeout",
      `${MESSAGE_REACT_WACLI_TIMEOUT_MS / 1000}s`,
      "--to",
      chat,
      "--id",
      id,
      "--reaction",
      reaction,
      ...(sender === undefined ? [] : ["--sender", sender]),
    ],
    { env, mode: "write", signal, timeoutMs: MESSAGE_REACT_PROCESS_LIMIT_MS },
  )
  return answerOf(result)
}
