import { existsSync, readFileSync } from "node:fs"
import { chmod, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord } from "./json-record"
import type { LabelPaths } from "./labels"

/** The absolute paths of the program the sync service runs and the script it runs. */
export type ServiceRecord = { program: string; script: string }

/** Name of the staging file the record is written to before it is renamed into place. */
const STAGING_NAME = ".service-program.json.tmp"

/** Owner read and write only, like the rest of the label's state. */
const RECORD_MODE = 0o600

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

/**
 * Writes the label's service record (mode 600) atomically: a staging file in the label directory
 * is renamed over the record, so a reader never sees a partial file and a link at its path is replaced.
 */
export async function writeServiceRecord(paths: LabelPaths, record: ServiceRecord): Promise<void> {
  const staging = join(paths.dir, STAGING_NAME)
  await unlinkIfPresent(staging)
  const body = `${JSON.stringify({ program: record.program, script: record.script })}\n`
  await writeFile(staging, body, { encoding: "utf8", mode: RECORD_MODE, flag: "wx" })
  await chmod(staging, RECORD_MODE)
  await rename(staging, paths.serviceRecord)
}

/**
 * The label's service record, or `null` when the file is missing, unreadable, not JSON,
 * or `program` or `script` is not a non-empty string. Never throws for those cases.
 */
export function readServiceRecord(paths: LabelPaths): ServiceRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(paths.serviceRecord, "utf8"))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const { program, script } = parsed
  if (!isNonEmptyString(program) || !isNonEmptyString(script)) return null
  return { program, script }
}

/** Deletes the label's service record; a missing file is not an error. */
export async function removeServiceRecord(paths: LabelPaths): Promise<void> {
  await unlinkIfPresent(paths.serviceRecord)
}

/**
 * Which of the record's paths no longer exist; `[]` when both do.
 * Links are followed, so a dangling link counts as missing.
 */
export function missingServiceFiles(record: ServiceRecord): Array<"program" | "script"> {
  const missing: Array<"program" | "script"> = []
  if (!existsSync(record.program)) missing.push("program")
  if (!existsSync(record.script)) missing.push("script")
  return missing
}
