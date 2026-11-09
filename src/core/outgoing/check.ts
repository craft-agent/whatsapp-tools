import { inspectArchive, type ArchiveListing } from "../archive/inspect"
import { CLASSIFY_HEAD_BYTES, classifyFile, type ArchiveFormat } from "../archive/kind"
import type { ArchiveLimits } from "../archive/limits"
import { ArchiveRefused } from "../archive/refused"
import { fileChunks, readAt } from "../archive/streams"
import { openForRead } from "../file/fs-safe"
import { scanData, scriptProblem } from "./content-scan"
import { checkEntries } from "./entries"
import { OutgoingRefused } from "./refused"

/** What a file that may be sent turned out to be. */
export type OutgoingCheck = { size: number; head: Buffer } & (
  { kind: "file" } | { kind: "archive"; format: ArchiveFormat; listing: ArchiveListing }
)

/** What `checkOutgoingFile` may be given besides the file. */
export type OutgoingCheckOptions = {
  /** Stops the reading with its `AbortError`. */
  signal?: AbortSignal
  /** What an archive may hold; a test injects smaller ones. */
  limits?: ArchiveLimits
}

/**
 * Judges the copy of a file that is about to be sent, by its bytes, and
 * returns its first bytes (`head`) for the caller to tell its kind. `name` is
 * the original file's name, which the copy does not carry. The copy is opened
 * without following a link and must be a regular file (checked on the open
 * file). Anything below is `OutgoingRefused`:
 *
 * - an empty file;
 * - a program, an installer or an archive that cannot be inspected, by the
 *   name and the first bytes (`classifyFile`; a local file declares no type);
 * - a name that says source code over bytes that are not text;
 * - a private key block anywhere in the file (`scanData`).
 *
 * An archive (zip, tar or gzipped tar) is inspected (`inspectArchive`), is
 * refused when it holds no files, and is then read once more entry by entry,
 * never unpacked, and every entry passes
 * the rules for a file in an archive (`checkEntries`): the key scan covers
 * every byte of every entry, and a refusal names the entry. A document built
 * on zip (`.docx`, `.epub`, …) is a file, not an archive: only its outer bytes
 * are scanned, so a key inside one of its parts is not found.
 */
export async function checkOutgoingFile(
  copyPath: string,
  { name }: { name: string },
  { signal, limits }: OutgoingCheckOptions = {},
): Promise<OutgoingCheck> {
  const file = await openForRead(copyPath)
  try {
    const stats = await file.stat()
    if (!stats.isFile()) throw new OutgoingRefused("not a regular file")
    const { size } = stats
    if (size === 0) throw new OutgoingRefused("an empty file")

    const head = await readAt(file, 0, Math.min(size, CLASSIFY_HEAD_BYTES))
    const kind = classifyFile({ name, head })
    if (kind.kind === "refused") throw new OutgoingRefused(kind.reason)
    if (kind.kind === "archive") {
      const problem = scriptProblem(name, head)
      if (problem !== undefined) throw new OutgoingRefused(problem)
      return {
        kind: "archive",
        format: kind.format,
        size,
        head,
        listing: await checkArchive(copyPath, kind.format, limits, signal),
      }
    }

    const problem = await scanData(name, fileChunks(file, 0, size), signal)
    if (problem !== undefined) throw new OutgoingRefused(problem)
    return { kind: "file", size, head }
  } finally {
    await file.close()
  }
}

/** Inspects the archive, then checks each entry; a refusal of either comes out as `OutgoingRefused`. */
async function checkArchive(
  path: string,
  format: ArchiveFormat,
  limits?: ArchiveLimits,
  signal?: AbortSignal,
): Promise<ArchiveListing> {
  try {
    const listing = await inspectArchive(path, format, limits, signal)
    if (listing.files === 0) throw new OutgoingRefused("an archive with no files")
    await checkEntries(path, format, limits, signal)
    return listing
  } catch (error) {
    if (error instanceof ArchiveRefused) throw new OutgoingRefused(error.reason, error.entry)
    throw error
  }
}
