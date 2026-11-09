import { join } from "node:path"
import { ToolError } from "../../errors"
import type { ArchiveLimits } from "../../archive/limits"
import { checkOutgoingFile, type OutgoingCheck } from "../../outgoing/check"
import { MAX_TOTAL_BYTES } from "../../outgoing/limits"
import { OutgoingRefused } from "../../outgoing/refused"
import type { ToolContext } from "../../tool"
import { openCallFolder, removeCallFolder, sweepOutbox } from "./outbox"
import { resolveFiles, type ResolvedFile } from "./resolve-files"
import { stageFile, type ByteBudget, type Staged } from "./stage"

/** A file copied into the call's folder and found fit to be sent. */
export type StagedFile = Staged & {
  /** The real path the file was copied from. */
  realPath: string
  /** What the checks found: its first bytes and, for an archive, its format and listing. */
  check: OutgoingCheck
}

/** The copies of one send, which exist until `remove` is called. */
export type StagedSend = {
  /** The call's folder in the outbox. */
  folder: string
  /** The copies, in the order the files were named. */
  files: StagedFile[]
  /** Removes the call's folder and everything in it; call it once the copies are used, whatever happened. */
  remove(): Promise<void>
}

/** What `stageOutgoing` is given besides the files. */
export type StageOptions = {
  /** The label's outbox, where the call's folder is made. */
  outbox: string
  /** The most bytes all the files may have together; a test injects a smaller one. */
  maxTotalBytes?: number
  /** What an archive may hold; a test injects smaller ones. */
  limits?: ArchiveLimits
  /** Stops the copying and checking with its `AbortError`. */
  signal?: AbortSignal
}

/** The refusal for a file the checks found cannot be sent: it names the file as the caller gave it, and the entry of an archive. */
function cannotBeSent(shown: string, refusal: OutgoingRefused): ToolError {
  const why = refusal.entry === undefined ? `it is ${refusal.reason}` : refusal.message
  return new ToolError("forbidden", `${shown} cannot be sent: ${why}.`, { cause: refusal })
}

/** Copies each file into the call's folder and judges the copy; throws for the first that cannot be sent. */
async function stageAll(
  files: readonly ResolvedFile[],
  folder: string,
  budget: ByteBudget,
  { limits, signal }: Pick<StageOptions, "limits" | "signal">,
): Promise<StagedFile[]> {
  const staged: StagedFile[] = []
  for (const [position, { shown, sha256, resolved }] of files.entries()) {
    const copy = await stageFile(resolved, shown, join(folder, String(position)), budget, sha256, signal)
    try {
      const check = await checkOutgoingFile(copy.path, { name: copy.name }, { signal, limits })
      staged.push({ ...copy, realPath: resolved.realPath, check })
    } catch (error) {
      throw error instanceof OutgoingRefused ? cannotBeSent(shown, error) : error
    }
  }
  return staged
}

/**
 * Sweeps the outbox of folders older than a day, resolves every named file
 * (`resolveFiles`), copies each into a new folder of the outbox and checks the
 * copies by their bytes. Nothing is read from the copies' sources after the
 * copy, so what is checked is what is sent. When any step fails the call's
 * folder is removed and the error thrown: `forbidden` for a file that cannot
 * be sent, `stale` for one that changed or does not match its `sha256`,
 * `invalid_argument` for a size over the limit. On success the caller owns the
 * folder and must call `remove`.
 */
export async function stageOutgoing(
  files: readonly { path: string; sha256?: string }[],
  ctx: Pick<ToolContext, "cwd" | "sendDirs" | "stateDir" | "ownDir">,
  options: StageOptions,
): Promise<StagedSend> {
  await sweepOutbox(options.outbox, Date.now())
  const resolved = await resolveFiles(files, ctx)
  const folder = await openCallFolder(options.outbox)
  try {
    const budget = { used: 0, limit: options.maxTotalBytes ?? MAX_TOTAL_BYTES }
    const staged = await stageAll(resolved, folder, budget, options)
    return { folder, files: staged, remove: () => removeCallFolder(folder) }
  } catch (error) {
    await removeCallFolder(folder).catch(() => {})
    throw error
  }
}
