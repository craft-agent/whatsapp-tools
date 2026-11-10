import { z } from "zod"
import { ToolError } from "../errors"
import { backfillOperation, HISTORY_BACKFILL_OP, type BackfillLimits } from "./backfill"
import {
  archiveChat,
  CHAT_ARCHIVE_OP,
  CHAT_MARK_OP,
  CHAT_MUTE_OP,
  CHAT_PIN_OP,
  markChat,
  muteChat,
  pinChat,
} from "./chat-state"
import { deleteOperation, MESSAGE_DELETE_OP } from "./delete"
import { editMessage, MESSAGE_EDIT_OP } from "./edit"
import { FILE_SEND_OP, sendFile } from "./file-send"
import { downloadFromPhone, MEDIA_DOWNLOAD_OP } from "./media"
import { MESSAGE_REACT_OP, reactToMessage } from "./react"
import { MESSAGE_SEND_OP, sendText } from "./send"
import type { ServiceOperationContext, ServiceOperations } from "./service-socket"
import { runWacli } from "./wacli"

/** The name of the service operation that asks WhatsApp which numbers have an account. */
export const CONTACTS_CHECK_OP = "contacts_check"

/** The most numbers one check takes: asking about many unknown numbers at once is what gets an account limited. */
export const MAX_CHECKED_NUMBERS = 20

/** A number the check takes: `+`, then 7 to 15 digits, the first not 0. */
export const CHECKED_NUMBER = /^\+[1-9][0-9]{6,14}$/

/** How long a check may take, which is also the deadline its caller gives the service. */
export const CONTACTS_CHECK_TIMEOUT_MS = 45_000

/** The arguments of `contacts_check`: the numbers already normalised, with no duplicates removed or added here. */
const checkArguments = z.strictObject({
  numbers: z.array(z.string().regex(CHECKED_NUMBER)).min(1).max(MAX_CHECKED_NUMBERS),
})

/**
 * What wacli prints for one number: `phone` is its digits, `registered` whether it has an account, and `responded`
 * whether WhatsApp answered for it at all (`registered: false` alone cannot tell a "no" from an omission).
 */
const checkedNumber = z.object({
  phone: z.string(),
  jid: z.string().optional(),
  registered: z.boolean(),
  responded: z.boolean(),
})

/** What `contacts_check` returns: wacli's answer for each number asked. */
export const checkResults = z.array(checkedNumber)

/** One number of the answer of `contacts_check`. */
export type CheckedNumber = z.infer<typeof checkedNumber>

/** Asks WhatsApp, through the running sync, which of `args.numbers` have an account; nothing is written. */
async function checkContacts(args: unknown, { paths, env, signal }: ServiceOperationContext) {
  const parsed = checkArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError(
      "invalid_argument",
      `contacts_check takes numbers: 1 to ${MAX_CHECKED_NUMBERS} numbers as + and 7 to 15 digits.`,
    )
  }
  const data = await runWacli(paths, ["contacts", "check", "--", ...parsed.data.numbers], {
    env,
    mode: "ask",
    signal,
    timeoutMs: CONTACTS_CHECK_TIMEOUT_MS,
  })
  const results = checkResults.safeParse(data)
  if (!results.success) throw new ToolError("upstream_error", "wacli returned a number check that cannot be read.")
  return results.data
}

/** What a caller may change in the service's operations; tests shorten the time limits. */
export type ServiceOperationOptions = {
  backfill?: BackfillLimits
}

/**
 * The operations the sync service takes from its callers. `contacts_check` runs while the sync runs, so wacli hands
 * the check to it, and writes nothing. `media_download` runs while the sync runs too: wacli hands the request to
 * upload a file again to it, and the sync writes the file. `message_send` runs while the sync runs too: wacli hands
 * the text to it, and the sync sends it; so does `file_send` with a file of the outbox, and `message_edit`, which
 * changes the text of a message the user sent, `message_react`, which reacts to a message, and `chat_archive`,
 * `chat_pin`, `chat_mute` and `chat_mark`, which set one state of a chat. `history_backfill` runs
 * with the sync stopped, and writes the local mirror; so does `message_delete`, which deletes a message the user sent
 * for everyone, since wacli does not hand that to a running sync.
 */
export function serviceOperations({ backfill }: ServiceOperationOptions = {}): ServiceOperations {
  return {
    [CONTACTS_CHECK_OP]: { kind: "delegated", writes: false, run: checkContacts },
    [MEDIA_DOWNLOAD_OP]: { kind: "delegated", writes: true, run: downloadFromPhone },
    [MESSAGE_SEND_OP]: { kind: "delegated", writes: true, run: sendText },
    [MESSAGE_EDIT_OP]: { kind: "delegated", writes: true, run: editMessage },
    [MESSAGE_REACT_OP]: { kind: "delegated", writes: true, run: reactToMessage },
    [CHAT_ARCHIVE_OP]: { kind: "delegated", writes: true, run: archiveChat },
    [CHAT_PIN_OP]: { kind: "delegated", writes: true, run: pinChat },
    [CHAT_MUTE_OP]: { kind: "delegated", writes: true, run: muteChat },
    [CHAT_MARK_OP]: { kind: "delegated", writes: true, run: markChat },
    [FILE_SEND_OP]: { kind: "delegated", writes: true, run: sendFile },
    [MESSAGE_DELETE_OP]: deleteOperation,
    [HISTORY_BACKFILL_OP]: backfillOperation(backfill),
  }
}
