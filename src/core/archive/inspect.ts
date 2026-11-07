import { cleanName } from "./clean-name"
import { PathRegistry, bundleProblem, plainPathProblem } from "./entry-names"
import { CLASSIFY_HEAD_BYTES, classifyFile, type ArchiveFormat } from "./kind"
import { DEFAULT_LIMITS, type ArchiveLimits } from "./limits"
import { ArchiveRefused } from "./refused"
import { readHead } from "./streams"
import { walkArchive } from "./walk"

/** One entry of a listing, under its cleaned name; a directory carries `dir: true`. */
export type ListedEntry = { name: string; size: number; dir?: true }

/** What an archive holds, once inspection has passed it. */
export type ArchiveListing = {
  format: ArchiveFormat
  entries: ListedEntry[]
  /** How many entries are files. */
  files: number
  /** The bytes the files unpack to, as read. */
  total_size: number
}

const FORMAT_LABELS: Record<ArchiveFormat, string> = { zip: "zip", tar: "tar", tgz: "gzipped tar" }

/**
 * Reads every byte of an archive and lists it, or throws `ArchiveRefused` for
 * the first thing that disqualifies it: a program, an installer or any other
 * archive inside (inspectable or not), a link or special file, an encrypted
 * entry, a path that is not plain and relative or holds a control or bidi
 * character, a path through an app or system bundle, two entries for one path
 * (also in other case or Unicode form), a file where a directory is, a damaged
 * archive, or more entries or bytes than the limits allow, counted from what
 * is read. An archive with nothing in it is accepted. The rules judge the
 * names as the archive wrote them; the listing shows them cleaned. `signal`
 * stops the reading with its `AbortError`, checked before each chunk of data.
 */
export async function inspectArchive(
  path: string,
  format: ArchiveFormat,
  limits: ArchiveLimits = DEFAULT_LIMITS,
  signal?: AbortSignal,
): Promise<ArchiveListing> {
  const entries: ListedEntry[] = []
  const paths = new PathRegistry()
  let files = 0
  let totalSize = 0

  await walkArchive(
    path,
    format,
    async (entry, data) => {
      const shown = cleanName(entry.name)
      const problem =
        plainPathProblem(entry.name, entry.dir) ?? bundleProblem(entry.name) ?? paths.add(entry.name, entry.dir)
      if (problem !== undefined) throw new ArchiveRefused(problem, shown)

      if (data !== null) {
        const kind = classifyFile({ name: entry.name, head: await readHead(data, CLASSIFY_HEAD_BYTES) })
        if (kind.kind === "refused") throw new ArchiveRefused(kind.reason, shown)
        if (kind.kind === "archive") {
          throw new ArchiveRefused(`an archive inside the archive (${FORMAT_LABELS[kind.format]})`, shown)
        }
        files++
        totalSize += entry.size
      }
      entries.push(entry.dir ? { name: shown, size: entry.size, dir: true } : { name: shown, size: entry.size })
    },
    limits,
    signal,
  )

  return { format, entries, files, total_size: totalSize }
}
