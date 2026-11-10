import { env } from "node:process"
import { withoutDevice } from "../chat/jid"
import { ToolError } from "../errors"
import { CHAT_JID_FORM } from "./backfill"
import { isRecord } from "./json-record"
import type { LabelPaths } from "./labels"
import { runWacli } from "./wacli"

/** How long `wacli doctor` may take. */
export const DOCTOR_TIMEOUT_MS = 20_000

/**
 * The JID of the account the label is linked to, without the device, as `wacli doctor` reports it from the store
 * (with `--read-only`, so beside the sync service). Undefined when wacli does not report one or its report cannot be
 * read; an abort is not swallowed. The JID is the account's own: it never goes into a result, an error or a log.
 */
export async function linkedJid(paths: LabelPaths, signal: AbortSignal | undefined): Promise<string | undefined> {
  let report: unknown
  try {
    report = await runWacli(paths, ["doctor"], { env, mode: "read", signal, timeoutMs: DOCTOR_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof ToolError) return undefined
    throw error
  }
  if (!isRecord(report) || typeof report.linked_jid !== "string") return undefined
  const jid = withoutDevice(report.linked_jid.trim())
  return CHAT_JID_FORM.test(jid) ? jid : undefined
}
