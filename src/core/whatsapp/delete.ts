import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { DELETED_MESSAGE, NOT_OWN_MESSAGE, NO_SUCH_MESSAGE } from "./edit"
import { MESSAGE_ID_FORM } from "./media"
import { sentOf, storeWarningOf, type SendOutcomeOptions } from "./send-outcome"
import { reachableChat } from "./send"
import type { ServiceOperation, ServiceOperationContext } from "./service-socket"
import { execWacli } from "./wacli"

/** The name of the service operation that deletes one message for everyone. */
export const MESSAGE_DELETE_OP = "message_delete"

/**
 * How long a deletion may take in all, which is the deadline its caller gives the service. The service stops its
 * child first (up to 15 s: SIGTERM, then SIGKILL after its grace), then wacli runs (up to the process limit, 75 s,
 * plus 2 s for the runner to kill it), then the service waits 1 s and starts the child again and waits 1 s more for
 * it to stay up: about 95 s at the worst. 120 s leaves the rest for the request to wait behind another one, and the
 * client allows 1 s past it, so the call ends well inside the 150 s a harness may give a tool call.
 */
export const MESSAGE_DELETE_DEADLINE_MS = 120_000

/** How long wacli itself may take for it (its `--timeout`), so that its own time-out is what is reported. */
const MESSAGE_DELETE_WACLI_TIMEOUT_MS = 60_000

/** How long the process may run before it is killed: past wacli's own time-out, within the service's deadline. */
const MESSAGE_DELETE_PROCESS_LIMIT_MS = 75_000

/** wacli's text when it deleted the message at WhatsApp but could not write that to the mirror. */
const STORE_FAILED = /^store deleted message state/i

/** wacli's text when the chat or the message id is missing. */
const MISSING_ARGUMENT = /^--chat and --id are required/i

/** The arguments of `message_delete`. */
const deleteArguments = z.strictObject({
  chat: reachableChat,
  id: z.string().regex(MESSAGE_ID_FORM),
})

/** What wacli prints for a deletion it made: `revoked`, beside the ids it names. */
const revokedMessage = z.object({ revoked: z.literal(true) })

/** What `message_delete` returns, besides the `service_running` the service adds: when wacli reported the deletion accepted (in milliseconds), and what wacli said when it could not write that to the mirror. */
const deleteResult = z.object({
  accepted_ms: z.number().int().nonnegative(),
  store_warning: z.string().min(1).optional(),
})

/** What a caller gets of `message_delete`: the result with the `service_running` the service adds. */
export const deleteAnswer = deleteResult.extend({ service_running: z.boolean() })

/** What a caller gets of a deletion WhatsApp accepted. */
export type DeleteAnswer = z.infer<typeof deleteAnswer>

type DeleteResult = z.infer<typeof deleteResult>

/** The error for a wacli text that says the request ended before anything was deleted, else undefined. */
function notSent(text: string): ToolError | undefined {
  if (NOT_OWN_MESSAGE.test(text)) {
    return new ToolError("forbidden", "Only the user's own messages can be deleted for everyone. Nothing was deleted.")
  }
  if (DELETED_MESSAGE.test(text)) {
    return new ToolError("not_found", "The message was already deleted. Nothing was deleted.")
  }
  if (MISSING_ARGUMENT.test(text)) {
    return new ToolError("invalid_argument", "wacli was given no chat or no message id. Nothing was deleted.")
  }
  // Said only by wacli's lookup of the message, before it connects; writing the mirror after the deletion is worded apart.
  if (NO_SUCH_MESSAGE.test(text)) {
    return new ToolError("not_found", "The message is not in the local store of the sync service. Nothing was deleted.")
  }
  return undefined
}

/** How the failures of a deletion are told. */
const OUTCOME: SendOutcomeOptions = {
  subject: "deletion",
  processLimitMs: MESSAGE_DELETE_PROCESS_LIMIT_MS,
  notSent,
}

/** The result of a deletion that succeeded, else the error it ended with; a success that proves no deletion is `uncertain`. */
function resultOf(result: ExecResult): DeleteResult {
  const storeWarning = storeWarningOf(result, STORE_FAILED)
  if (storeWarning !== undefined) return { accepted_ms: Date.now(), store_warning: storeWarning }
  sentOf(result, revokedMessage, OUTCOME)
  return { accepted_ms: Date.now() }
}

/**
 * Deletes one message for everyone, through wacli running on its own: with the service's child stopped the operation
 * holds the store, so wacli connects to WhatsApp itself. A failure known to have happened before anything left keeps
 * its code; every other failure is `uncertain`, since the deletion may have gone out. A failure of writing the
 * deletion to the mirror alone is a success that carries wacli's warning.
 */
async function deleteForEveryone(
  args: unknown,
  { paths, env, signal }: ServiceOperationContext,
): Promise<DeleteResult> {
  const parsed = deleteArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError("invalid_argument", "message_delete takes chat (a JID) and id (a message id).")
  }
  const { chat, id } = parsed.data
  const result = await execWacli(
    paths,
    ["messages", "delete", "--timeout", `${MESSAGE_DELETE_WACLI_TIMEOUT_MS / 1000}s`, "--chat", chat, "--id", id],
    { env, mode: "write", signal, timeoutMs: MESSAGE_DELETE_PROCESS_LIMIT_MS },
  )
  return resultOf(result)
}

/**
 * The `message_delete` operation. wacli does not hand a deletion for everyone to a running sync, and it holds the
 * store's lock, so it runs with the child stopped; the service starts the child again whatever becomes of it.
 */
export const deleteOperation: ServiceOperation = { kind: "exclusive", writes: true, run: deleteForEveryone }
