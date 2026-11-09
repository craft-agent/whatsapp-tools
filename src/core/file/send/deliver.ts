import { ToolError, isAbortError, isToolError } from "../../errors"
import { deliveryFailure, uncertainMessage } from "../../message/recipient"
import { formatLocalTime } from "../../time"
import {
  FILE_SEND_MAX_TIMEOUT_MS,
  FILE_SEND_OP,
  FILE_SEND_SERVICE_MARGIN_MS,
  fileSendAnswer,
} from "../../whatsapp/file-send"
import type { LabelPaths } from "../../whatsapp/labels"
import { callService } from "../../whatsapp/service-client"
import type { SendKind } from "./kinds"
import type { SentMessage } from "./schema"
import type { StagedFile } from "./stage-files"

/** What the sending of a call's files may spend of the time the call has. */
export type FileSendTiming = {
  /** How long the whole call may take, from its start. */
  budgetMs: number
  /** The least time a file is given; a file is not started with less, since an upload would only be cut off. */
  minFileMs: number
  /** How long past a file's time the service's deadline is, and so what is kept back for the files after it. */
  marginMs: number
}

/** How long a call may take in all, from its start: 20 seconds under the 300 a client gives a tool call, for the work around the sending. */
export const FILE_SEND_BUDGET_MS = 280_000

/** The timing of a call. */
export const FILE_SEND_TIMING: FileSendTiming = {
  budgetMs: FILE_SEND_BUDGET_MS,
  minFileMs: 30_000,
  marginMs: FILE_SEND_SERVICE_MARGIN_MS,
}

/** A file ready to be sent, and how it is shown. */
export type OutgoingFile = { file: StagedFile; kind: SendKind }

/** What a send of several files has in common. */
export type FileDelivery = {
  paths: LabelPaths
  chat: string
  /** The caption and the quote go on the first file only. */
  caption?: string
  replyTo?: string
  signal?: AbortSignal
  /** When the call started, in milliseconds since the epoch, which its time is counted from. */
  startedAt: number
  timing: FileSendTiming
}

/** A file WhatsApp accepted, and what wacli said when it could not write it to the mirror. */
export type AcceptedFile = { message: SentMessage; warning?: string }

const CANCELLED_MESSAGE =
  "The call was cancelled while the files were being sent, so the file it was on may have gone out."

const FURTHER_ADVICE =
  "Read the chat with whatsapp_chat_read and ask the user before sending anything again; never send them again on your own."

const SENT_ADVICE = `Never send the files that went out again. ${FURTHER_ADVICE}`

function noTimeLeft(name: string): string {
  return `The call's time ran out: there was no time left to send ${JSON.stringify(name)}; nothing of it was sent. Send it in a new call.`
}

/** Sends one file through the service, within the time the call has left; throws what the text send would for it. */
async function sendOne(
  { file, kind }: OutgoingFile,
  first: boolean,
  { paths, chat, caption, replyTo, signal, startedAt, timing }: FileDelivery,
): Promise<AcceptedFile> {
  const remainingMs = timing.budgetMs - (Date.now() - startedAt)
  const timeoutMs = Math.min(Math.floor(remainingMs - timing.marginMs), FILE_SEND_MAX_TIMEOUT_MS)
  if (timeoutMs < timing.minFileMs) throw new ToolError("upstream_error", noTimeLeft(file.name))
  let data: unknown
  try {
    data = await callService(
      paths,
      FILE_SEND_OP,
      {
        chat,
        file: file.path,
        name: file.name,
        as: kind.as,
        mime: kind.mime,
        ...(first && caption !== undefined ? { caption } : {}),
        ...(first && replyTo !== undefined ? { reply_to: replyTo } : {}),
        timeout_ms: timeoutMs,
      },
      { mode: "write", timeoutMs: timeoutMs + timing.marginMs, signal },
    )
  } catch (error) {
    throw deliveryFailure(error, "file")
  }
  const answer = fileSendAnswer.safeParse(data)
  if (!answer.success) throw new ToolError("uncertain", uncertainMessage("file"), { cause: answer.error })
  const { id, accepted_ms: acceptedMs, as, store_warning: warning } = answer.data
  return { message: { name: file.name, id, time: formatLocalTime(acceptedMs), as }, ...(warning ? { warning } : {}) }
}

/** The message of a call that stopped at `name` after `sent` of `total` files went out: where it stopped, why, and what to do. */
function stoppedMessage(cause: ToolError, name: string, sent: number, total: number): string {
  const uncertain = cause.code === "uncertain"
  const quoted = JSON.stringify(name)
  if (sent === 0 && !uncertain) {
    return `None of the ${total} files went out (${quoted} was not sent, and the files after it were not tried). The error was: ${cause.message}`
  }
  if (sent === 0) {
    return `${quoted}, the first of ${total} files, may have gone out, and the files after it were not sent. The error was: ${cause.message} ${FURTHER_ADVICE}`
  }
  const why = uncertain ? "it may have gone out too" : "it was not sent"
  const rest = total - sent - 1 > 0 ? ", and the files after it were not tried" : ""
  return `${sent} of ${total} files went out before ${quoted} (${why}${rest}). The error was: ${cause.message} ${SENT_ADVICE}`
}

/**
 * What to throw when the file at position `accepted.length` was not accepted. A cancellation before anything went out
 * stays one, and the one file of a send of one fails as the text send does. Otherwise the error has the code of the
 * file that stopped the call (a cancellation counts as `uncertain`, since the file may have gone), says how many files
 * went out, and lists in `details` what was sent, with the message ids, what stopped the call and what was not tried.
 */
function stoppedError(error: unknown, files: readonly OutgoingFile[], accepted: readonly AcceptedFile[]): unknown {
  const sent = accepted.length
  if ((sent === 0 && isAbortError(error)) || files.length === 1) return error
  const cause = isToolError(error)
    ? error
    : new ToolError("uncertain", isAbortError(error) ? CANCELLED_MESSAGE : uncertainMessage("file"), { cause: error })
  const name = files[sent]!.file.name
  return new ToolError(cause.code, stoppedMessage(cause, name, sent, files.length), {
    cause,
    details: {
      sent: accepted.map(({ message }) => message),
      stopped: { name, code: cause.code },
      not_sent: files.slice(sent + 1).map(({ file }) => file.name),
    },
  })
}

/**
 * Sends the files one by one, in order, through the service; the caption and the quote go on the first. The first
 * file that is not accepted stops the rest, and the call fails as `stoppedError` says. A file is not started when
 * the call's time leaves it less than the least a file is given.
 */
export async function sendInOrder(files: readonly OutgoingFile[], delivery: FileDelivery): Promise<AcceptedFile[]> {
  const accepted: AcceptedFile[] = []
  for (const [position, outgoing] of files.entries()) {
    try {
      accepted.push(await sendOne(outgoing, position === 0, delivery))
    } catch (error) {
      throw stoppedError(error, files, accepted)
    }
  }
  return accepted
}
