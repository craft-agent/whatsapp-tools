import { z } from "zod"
import { ToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { runWacli, type WacliRunOptions } from "./wacli"

/** How long reading the coverage of one chat may take. */
const COVERAGE_TIMEOUT_MS = 10_000

/** One chat of `wacli history coverage`: how many messages the mirror holds of it and from when. */
const coverageRow = z.object({
  chat_jid: z.string(),
  message_count: z.number().int().nonnegative(),
  oldest_ts: z.string(),
})

/** What `wacli history coverage` prints; wacli prints `null` for an empty list. */
const coverageData = z.object({ coverage: z.array(coverageRow).nullable() })

/** What the mirror holds of one chat. */
export type ChatCoverage = {
  /** How many messages (rows included that hold nothing readable) the mirror holds of the chat. */
  held: number
  /** The time of the oldest one in milliseconds, or null when the mirror holds none. */
  oldestMs: number | null
}

/**
 * What the account's mirror holds of the chat `chat`, read with `--read-only` (so it works beside a running sync or
 * with none), or undefined when the mirror has no such chat. A coverage wacli printed that cannot be read is
 * `upstream_error`.
 */
export async function readCoverage(
  paths: LabelPaths,
  chat: string,
  options: Pick<WacliRunOptions, "env" | "signal">,
): Promise<ChatCoverage | undefined> {
  const data = await runWacli(paths, ["history", "coverage", "--chat", chat, "--include-blocked"], {
    ...options,
    mode: "read",
    timeoutMs: COVERAGE_TIMEOUT_MS,
  })
  const parsed = coverageData.safeParse(data)
  if (!parsed.success) throw new ToolError("upstream_error", "wacli returned a history coverage that cannot be read.")
  const row = parsed.data.coverage?.find((candidate) => candidate.chat_jid === chat)
  if (!row) return undefined
  // A chat with no message has no oldest time: wacli prints a zero time there.
  if (row.message_count === 0) return { held: 0, oldestMs: null }
  const oldestMs = Date.parse(row.oldest_ts)
  if (Number.isNaN(oldestMs)) {
    throw new ToolError("upstream_error", "wacli returned a history coverage with a time that cannot be read.")
  }
  return { held: row.message_count, oldestMs }
}
