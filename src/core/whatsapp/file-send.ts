import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { isWithin } from "../paths"
import { MESSAGE_ID_FORM } from "./media"
import {
  LONE_SURROGATE,
  acceptedOf,
  commonNotSent,
  detailOf,
  sendAnswer,
  sentOf,
  type SendOutcomeOptions,
} from "./send-outcome"
import { reachableChat } from "./send"
import type { ServiceOperationContext } from "./service-socket"
import { execWacli } from "./wacli"

/** The name of the service operation that sends one file. */
export const FILE_SEND_OP = "file_send"

/** The ways WhatsApp shows a file: as a photo, a video, an audio message or a document. */
export const SEND_AS = ["image", "video", "audio", "document"] as const

/** One way WhatsApp shows a file. */
export type SendAs = (typeof SEND_AS)[number]

/** The most characters one caption has, counted as code points. */
export const FILE_CAPTION_MAX_CHARACTERS = 1024

/** The least time a caller may give one file, which is the time `file_send` counts its own limits from. */
export const FILE_SEND_MIN_TIMEOUT_MS = 10_000

/** The most time a caller may give one file. */
export const FILE_SEND_MAX_TIMEOUT_MS = 280_000

/** How long past the time it gives a file a caller sets the service's deadline, so that a request waiting behind another still has its time. */
export const FILE_SEND_SERVICE_MARGIN_MS = 10_000

/** How far under the time a file is given wacli's own `--timeout` is, so that wacli's own time-out is what is reported. */
const WACLI_TIMEOUT_MARGIN_MS = 15_000

/** How far under the time a file is given the process is killed: past wacli's own time-out, within the time. */
const PROCESS_LIMIT_MARGIN_MS = 5_000

/** The shortest `--timeout` given to wacli, which counts whole seconds. */
const MIN_WACLI_TIMEOUT_MS = 1_000

/** A type and subtype as an HTTP media type names them, without parameters. */
const MIME_FORM = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/

/** The longest media type wacli is given. */
const MAX_MIME_LENGTH = 127

/** wacli's texts for a file it refused before it uploaded anything, which do not name the file. */
const REFUSED_BEFORE_UPLOAD = [
  "--to and --file are required",
  "file too large",
  "open media within WACLI_MEDIA_ROOTS",
  "invalid --as",
]

/** wacli's texts for an image it could not read, which it says before it sends the message. */
const NOT_AN_IMAGE = /^\s*(?:error:\s*)?invalid image (?:data|dimensions)/i

/** whatsmeow's own texts for an upload that failed, which wacli returns as they are; the message is sent after the upload. */
const UPLOAD_FAILED =
  /^\s*(?:error:\s*)?(?:failed to refresh media connections|upload failed with status code|failed to encrypt file)/i

/** The arguments of `file_send`. */
const fileSendArguments = z.strictObject({
  chat: reachableChat,
  file: z.string().refine((file) => isAbsolute(file) && !file.includes("\0")),
  name: z
    .string()
    .min(1)
    .refine((name) => !name.includes("/") && !name.includes("\0")),
  as: z.enum(SEND_AS),
  mime: z.string().max(MAX_MIME_LENGTH).regex(MIME_FORM),
  caption: z
    .string()
    .min(1)
    .refine(
      (caption) =>
        [...caption].length <= FILE_CAPTION_MAX_CHARACTERS && !caption.includes("\0") && !LONE_SURROGATE.test(caption),
    )
    .optional(),
  reply_to: z.string().regex(MESSAGE_ID_FORM).optional(),
  timeout_ms: z.number().int().min(FILE_SEND_MIN_TIMEOUT_MS).max(FILE_SEND_MAX_TIMEOUT_MS),
})

/** What wacli prints for a file it sent: `sent`, the id WhatsApp gave the message, and how the file was shown. */
const sentFile = z.object({
  sent: z.literal(true),
  id: z.string().min(1),
  file: z
    .object({ media: z.enum(SEND_AS) })
    .optional()
    .catch(undefined),
  store_warning: z.string().optional(),
})

/** What `file_send` returns: what `message_send` does, and how WhatsApp showed the file. */
export const fileSendAnswer = sendAnswer.extend({ as: z.enum(SEND_AS) })

/** What wacli reported of a file WhatsApp accepted. */
export type FileSendAnswer = z.infer<typeof fileSendAnswer>

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The texts `file` is written as in wacli's errors: as given, made clean as wacli makes a path absolute, and by its real path, which wacli prints once it has resolved the links on the way. */
function spellings(file: string, real: string): string[] {
  return [...new Set([file, resolve(file), real])]
}

/** The texts of wacli that open an error about `file`, or the arguments, before anything is uploaded: the file is not there, not a regular file, outside its roots or too large. */
function fileRefusal(file: string, real: string): RegExp {
  const at = `(?:${spellings(file, real).map(escaped).join("|")})`
  const opens = [
    ...REFUSED_BEFORE_UPLOAD.map(escaped),
    `${at} is (?:not a regular file|outside WACLI_MEDIA_ROOTS)`,
    `(?:stat|open) ${at}: no such file or directory`,
    `resolve ${at}: `,
  ]
  return new RegExp(`^\\s*(?:error:\\s*)?(?:${opens.join("|")})`, "i")
}

/** wacli's text with the file's path left out: it names the account's outbox, and the caller knows the file by its own name. */
function withoutPath(text: string, file: string, real: string): string {
  return spellings(file, real).reduce((rest, spelling) => rest.split(spelling).join("the file"), text)
}

/** The error for a wacli text that says the request ended before anything was sent, else undefined. */
function notSentOf(file: string, real: string): SendOutcomeOptions["notSent"] {
  const refusal = fileRefusal(file, real)
  return (text) => {
    const known = commonNotSent(text)
    if (known) return known
    if (refusal.test(text)) {
      return new ToolError(
        "invalid_argument",
        `wacli refused the file (${detailOf(withoutPath(text, file, real))}). Nothing was sent.`,
      )
    }
    if (NOT_AN_IMAGE.test(text)) {
      return new ToolError(
        "invalid_argument",
        `wacli could not read the file as an image (${detailOf(text)}). Nothing was sent; send it as a document instead.`,
      )
    }
    if (UPLOAD_FAILED.test(text)) {
      return new ToolError(
        "upstream_error",
        `WhatsApp's media server did not take the file (${detailOf(text)}). Nothing was sent; sending again is safe.`,
      )
    }
    return undefined
  }
}

/** The real path of `file`; refuses, before wacli runs, any file that is not a regular file inside the account's outbox, by real path. */
async function requireInOutbox(outbox: string, file: string): Promise<string> {
  try {
    const real = await realpath(file)
    if ((await stat(real)).isFile() && (await isWithin(real, outbox))) return real
  } catch {
    // a file that cannot be resolved is refused like one outside
  }
  throw new ToolError(
    "invalid_argument",
    "file_send takes only a regular file inside the account's outbox. Nothing was sent.",
  )
}

/** The answer of a file send that succeeded, else the error it ended with; a success that proves no send is `uncertain`. */
function answerOf(result: ExecResult, file: string, real: string, as: SendAs, processLimitMs: number): FileSendAnswer {
  const sent = sentOf(result, sentFile, {
    subject: "file",
    processLimitMs,
    notSent: notSentOf(file, real),
  })
  return { ...acceptedOf(sent.id, sent.store_warning), as: sent.file?.media ?? as }
}

/**
 * Sends one file, already copied into the account's outbox, through the running sync: wacli runs without
 * `--read-only`, so it hands the send to the sync, which reads the file when it sends it. `timeout_ms` is the time the
 * caller gives this file: wacli's own time-out is 15 seconds under it and the process is killed 5 seconds under it.
 * A failure known to have happened before anything left keeps its code; every other failure is `uncertain`, since
 * the file may have gone out.
 */
export async function sendFile(
  args: unknown,
  { paths, env, signal }: ServiceOperationContext,
): Promise<FileSendAnswer> {
  const parsed = fileSendArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError(
      "invalid_argument",
      `file_send takes chat (a JID), file (an absolute path), name, as (${SEND_AS.join(", ")}), mime, caption (1 to ${FILE_CAPTION_MAX_CHARACTERS} characters, optional), reply_to (a message id, optional) and timeout_ms (${FILE_SEND_MIN_TIMEOUT_MS} to ${FILE_SEND_MAX_TIMEOUT_MS}).`,
    )
  }
  const { chat, file, name, as, mime, caption, reply_to: replyTo, timeout_ms: timeoutMs } = parsed.data
  const real = await requireInOutbox(paths.outbox, file)
  const wacliSeconds = Math.floor(Math.max(timeoutMs - WACLI_TIMEOUT_MARGIN_MS, MIN_WACLI_TIMEOUT_MS) / 1000)
  const processLimitMs = timeoutMs - PROCESS_LIMIT_MARGIN_MS
  const result = await execWacli(
    paths,
    [
      "send",
      "file",
      "--timeout",
      `${wacliSeconds}s`,
      "--to",
      chat,
      "--file",
      file,
      "--filename",
      name,
      "--as",
      as,
      "--mime",
      mime,
      ...(caption === undefined ? [] : ["--caption", caption]),
      ...(replyTo === undefined ? [] : ["--reply-to", replyTo]),
    ],
    { env, mode: "write", signal, timeoutMs: processLimitMs },
  )
  return answerOf(result, file, real, as, processLimitMs)
}
