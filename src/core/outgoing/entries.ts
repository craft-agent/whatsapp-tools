import { cleanName } from "../archive/clean-name"
import type { ArchiveFormat } from "../archive/kind"
import type { ArchiveLimits } from "../archive/limits"
import { walkArchive } from "../archive/walk"
import { scanData } from "./content-scan"
import { isDeniedFolder, isDeniedName } from "./deny-lists"
import { OutgoingRefused } from "./refused"

/**
 * Both separators split an entry's name: `inspectArchive` already refuses a
 * backslash, but a name the Windows way (`project\.ssh\id_rsa`) must not get
 * past these rules should that ever change.
 */
const SEPARATORS = /[\\/]/

/**
 * Reads an archive once more, entry by entry and without unpacking it, and
 * throws `OutgoingRefused` naming the cleaned entry for the first one that
 * must not leave: a path component that is a key or settings folder, a file
 * name that looks like a key or a secret, a name that says source code over
 * bytes that are not text, or a private key block anywhere in its data. Every
 * byte of every entry is read. The archive itself is for `inspectArchive` to
 * judge first; this adds the rules for what is sent.
 */
export async function checkEntries(
  path: string,
  format: ArchiveFormat,
  limits?: ArchiveLimits,
  signal?: AbortSignal,
): Promise<void> {
  await walkArchive(
    path,
    format,
    async (entry, data) => {
      const shown = cleanName(entry.name)
      const components = entry.name.split(SEPARATORS).filter((component) => component !== "")
      const folder = components.find(isDeniedFolder)
      if (folder !== undefined) {
        throw new OutgoingRefused(`inside a key or settings folder (${cleanName(folder)})`, shown)
      }
      if (data === null) return
      if (isDeniedName(components.at(-1) ?? "")) throw new OutgoingRefused("named like a key or a secret", shown)
      const problem = await scanData(entry.name, data, signal)
      if (problem !== undefined) throw new OutgoingRefused(problem, shown)
    },
    limits,
    signal,
  )
}
