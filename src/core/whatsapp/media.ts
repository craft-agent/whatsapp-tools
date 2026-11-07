import { lstat } from "node:fs/promises"
import { userInfo } from "node:os"
import { basename, dirname, isAbsolute } from "node:path"
import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { CHAT_JID_FORM } from "./backfill"
import type { ServiceOperationContext } from "./service-socket"
import { execWacli, failureText, readEnvelope, wacliError } from "./wacli"

/** The name of the service operation that asks the phone to upload a file WhatsApp's server no longer serves. */
export const MEDIA_DOWNLOAD_OP = "media_download"

/** How long a download may take in all, which is the deadline its caller gives the service. */
export const MEDIA_DOWNLOAD_DEADLINE_MS = 150_000

/** How long wacli may run for it: a little less than the deadline, so that its own time-out is what is reported. */
const MEDIA_DOWNLOAD_WACLI_LIMIT_MS = 140_000

/** What a message id looks like to the tools: it starts with a letter or a digit, then those and `.`, `_` and `-`, so it is also a plain folder name. */
export const MESSAGE_ID_FORM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** wacli's text when neither the server nor the phone has the file. */
const NO_LONGER_ON_PHONE = /media no longer available on phone/i

/** wacli's texts when the phone did not send the file it was asked for. */
const RECOVERY_FAILED = /media recovery/i

const GONE_EVERYWHERE =
  "WhatsApp's server no longer has this file and the phone does not have it now either, so it cannot be saved."

const PHONE_DID_NOT_SEND =
  "The phone did not send the file WhatsApp's server no longer has. Is the phone online with WhatsApp open? Asking again is safe."

/** The arguments of `media_download`. */
const mediaArguments = z.strictObject({
  chat: z.string().regex(CHAT_JID_FORM),
  id: z.string().regex(MESSAGE_ID_FORM),
  output: z.string(),
})

/** What `media_download` returns: where wacli wrote the file, how many bytes, and where it got them from. */
export const mediaAnswer = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  source: z.string(),
})

/** What wacli reported of a download the phone made. */
export type MediaAnswer = z.infer<typeof mediaAnswer>

function currentUid(): number | undefined {
  try {
    const uid = userInfo().uid
    return typeof uid === "number" && uid >= 0 ? uid : undefined
  } catch {
    return undefined
  }
}

const INVALID_OUTPUT =
  "media_download writes to output: an absolute path to a new file in a private mode 0700 folder starting with '.' that is not a link."

/** `invalid_argument` unless `output` is an absolute path to a non-existent file in a private mode 0700 folder starting with `.` that is not a link. */
async function checkOutput(output: string): Promise<void> {
  if (!isAbsolute(output)) {
    throw new ToolError("invalid_argument", INVALID_OUTPUT)
  }
  try {
    await lstat(output)
    throw new ToolError("invalid_argument", INVALID_OUTPUT)
  } catch (error) {
    if (error instanceof ToolError) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ToolError("invalid_argument", INVALID_OUTPUT)
    }
  }
  const parent = dirname(output)
  const parentName = basename(parent)
  if (!parentName.startsWith(".") || parentName === "." || parentName === "..") {
    throw new ToolError("invalid_argument", INVALID_OUTPUT)
  }
  let parentStat
  try {
    parentStat = await lstat(parent)
  } catch {
    throw new ToolError("invalid_argument", INVALID_OUTPUT)
  }
  if (!parentStat.isDirectory()) {
    throw new ToolError("invalid_argument", INVALID_OUTPUT)
  }
  if ((parentStat.mode & 0o777) !== 0o700) {
    throw new ToolError("invalid_argument", INVALID_OUTPUT)
  }
  const uid = currentUid()
  if (uid !== undefined && parentStat.uid !== uid) {
    throw new ToolError("invalid_argument", INVALID_OUTPUT)
  }
}

/** The error for wacli's own words about a download the phone could not make, when they are those. */
function phoneFailure(text: string): ToolError | undefined {
  if (NO_LONGER_ON_PHONE.test(text)) return new ToolError("not_found", GONE_EVERYWHERE)
  if (RECOVERY_FAILED.test(text)) return new ToolError("upstream_error", PHONE_DID_NOT_SEND)
  return undefined
}

/** The answer of a download that succeeded, else the error it ended with. */
function answerOf(result: ExecResult): MediaAnswer {
  if (result.code === 0 && !result.timedOut && !result.signal) {
    const envelope = readEnvelope(result.stdout)
    if (envelope?.success && "data" in envelope) {
      const answer = mediaAnswer.safeParse(envelope.data)
      if (!answer.success) throw new ToolError("upstream_error", "wacli returned a download that cannot be read.")
      return answer.data
    }
  }
  const text = failureText(result)
  const phone = text === undefined ? undefined : phoneFailure(text)
  throw phone ?? wacliError(result, "write", MEDIA_DOWNLOAD_WACLI_LIMIT_MS)
}

/**
 * Asks the phone, through the running sync, for a file WhatsApp's server no longer serves, and has wacli write it to
 * `output`. wacli runs without `--read-only` so that it hands the request to the running sync, which writes the
 * file. `not_found` when neither the server nor the phone has it, `upstream_error` when the phone did not send it.
 */
export async function downloadFromPhone(args: unknown, { paths, env, signal }: ServiceOperationContext) {
  const parsed = mediaArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError("invalid_argument", "media_download takes chat (a JID), id (a message id) and output (a path).")
  }
  const { chat, id, output } = parsed.data
  await checkOutput(output)
  const result = await execWacli(
    paths,
    ["media", "download", "--chat", chat, "--id", id, "--output", output, "--retry-on-phone"],
    { env, mode: "write", signal, timeoutMs: MEDIA_DOWNLOAD_WACLI_LIMIT_MS },
  )
  return answerOf(result)
}
