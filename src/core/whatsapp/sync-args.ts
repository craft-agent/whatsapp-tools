import type { LabelPaths } from "./labels"
import { wacliArgs } from "./wacli"

/**
 * The flags of the sync service's child: it follows until stopped, reports its lifecycle on standard error, never
 * gives up reconnecting, treats a stream silent for 90 seconds as stale, stays out of sight (quiet presence, so the
 * phone keeps its notifications), spaces sends one to three seconds apart, and refreshes contacts and groups.
 */
export const SYNC_ARGS = [
  "sync",
  "--follow",
  "--events",
  "--max-reconnect",
  "0",
  "--stale-threshold",
  "90s",
  "--presence-mode",
  "quiet",
  "--send-spacing",
  "1s-3s",
  "--refresh-contacts",
  "--refresh-groups",
] as const

/** The arguments for the sync child on one label's store. */
export function syncArgv(paths: LabelPaths): string[] {
  return wacliArgs(paths, [...SYNC_ARGS], { readOnly: false })
}
