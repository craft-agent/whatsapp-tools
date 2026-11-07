import { rm } from "node:fs/promises"
import { env } from "node:process"
import { z } from "zod"
import { ToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { MEDIA_DOWNLOAD_DEADLINE_MS, MEDIA_DOWNLOAD_OP, mediaAnswer } from "./media"
import { callService } from "./service-client"
import { runWacli } from "./wacli"

/** wacli's text when WhatsApp's server answers that the file is gone, or that it may not be had any more. */
const GONE_FROM_SERVER = /download failed with status code (?:403|404|410)/i

/** The service's answer when it is not running, which `callService` words itself. */
const SERVICE_NOT_RUNNING = /is not running/i

const GONE_FROM_SERVER_MESSAGE = "The file is no longer on WhatsApp's server."

/** What wacli reports of a download it made without the phone: only where it wrote the file is read. */
const reportedDownload = z.object({ path: z.string() })

/** Which message's file to fetch, and the new file to write it to. */
export type MediaDownload = {
  paths: LabelPaths
  chat: string
  id: string
  /** An absolute path in an existing folder, where nothing else is written; wacli writes the file there. */
  output: string
  signal?: AbortSignal
}

/**
 * The error for a request to the phone that failed in the service or on the way to it. A service that is not running
 * says so, with why the phone is being asked at all. An `uncertain` outcome stays so, but saving again is safe: the
 * request writes only the private file asked for, and sends nothing to anyone.
 */
function phoneRequestError(error: unknown): unknown {
  if (!(error instanceof ToolError)) return error
  if (error.code === "upstream_error" && SERVICE_NOT_RUNNING.test(error.message)) {
    return new ToolError(
      "upstream_error",
      `${GONE_FROM_SERVER_MESSAGE} Asking the phone for it needs the account's sync service running (see whatsapp_account_read). ${error.message}`,
      { cause: error },
    )
  }
  if (error.code === "uncertain") {
    return new ToolError(
      "uncertain",
      `${error.message} The request only asks the phone for the file to write to a private folder and sends nothing, so saving again is safe.`,
      { cause: error },
    )
  }
  return error
}

/** Asks the phone for the file through the account's sync service, which hands the request to its running sync. */
async function askPhone({ paths, chat, id, output, signal }: MediaDownload): Promise<unknown> {
  // A download that failed may have left a part of the file behind; the sync writes the whole file anew.
  await rm(output, { force: true })
  let data: unknown
  try {
    data = await callService(
      paths,
      MEDIA_DOWNLOAD_OP,
      { chat, id, output },
      { mode: "write", timeoutMs: MEDIA_DOWNLOAD_DEADLINE_MS, signal },
    )
  } catch (error) {
    throw phoneRequestError(error)
  }
  const answer = mediaAnswer.safeParse(data)
  if (!answer.success)
    throw new ToolError("upstream_error", "The sync service returned a download that cannot be read.")
  return answer.data
}

/**
 * Has wacli download the file of one message to `output`, reading beside the sync (`--read-only`). When WhatsApp's
 * server answers that the file is gone (403, 404 or 410), the account's sync service is asked to have the phone upload
 * it again. Resolves once wacli reports the file at `output`; the path it reports is read for that only. A path
 * wacli reports that is not the one asked for is `upstream_error`.
 */
export async function downloadMedia(download: MediaDownload): Promise<void> {
  const { paths, chat, id, output, signal } = download
  let data: unknown
  try {
    data = await runWacli(paths, ["media", "download", "--chat", chat, "--id", id, "--output", output], {
      env,
      mode: "read",
      signal,
      timeoutMs: MEDIA_DOWNLOAD_DEADLINE_MS,
    })
  } catch (error) {
    if (!(error instanceof ToolError) || !GONE_FROM_SERVER.test(error.message)) throw error
    data = await askPhone(download)
  }
  const reported = reportedDownload.safeParse(data)
  if (!reported.success || reported.data.path !== output) {
    throw new ToolError("upstream_error", "wacli did not report the file at the path it was asked to write it to.")
  }
}
