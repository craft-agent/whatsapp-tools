import { lstat, mkdir, rename, rmdir } from "node:fs/promises"
import { join } from "node:path"
import { bundleProblem, plainPathProblem } from "../archive/entry-names"
import { cleanName } from "../archive/clean-name"
import { inspectArchive } from "../archive/inspect"
import { classifyFile } from "../archive/kind"
import type { ArchiveLimits } from "../archive/limits"
import { ArchiveRefused } from "../archive/refused"
import { walkArchive } from "../archive/walk"
import { DIRECTORY_MODE } from "./constants"
import { errorCode, openForRead } from "./fs-safe"
import { unpackedName } from "./names"
import { copyToPartial, discard, privateName } from "./place"
import { Staging } from "./staging"

/** An archive saved in a folder, to be unpacked beside itself. */
export type UnpackRequest = {
  /** Where the saved archive is. */
  archivePath: string
  /** The name it is saved under. */
  name: string
  /** The content type its sender gave it. */
  type?: string
  /** The message's folder, which it is in. */
  folder: string
  signal?: AbortSignal
  /** What an archive may hold; the defaults of `inspectArchive` when absent. */
  limits?: ArchiveLimits
  /** For a test: called after the unpacked folder is made and before the staging folder is renamed onto it. */
  beforeRename?: (target: string) => void | Promise<void>
}

export type Unpacked = { path: string; alreadyUnpacked: boolean }

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/** How many names, the first and then numbered ones, are tried for the unpacked folder. */
const MAX_VARIANTS = 1000

/**
 * Publishes the finished staging folder as `<name>.unpacked`, or the first
 * `<name> (n).unpacked` that can be made. The target is made first with
 * `mkdir`, which fails if anything has that name, so nothing is ever replaced;
 * the staging folder is then renamed onto it, which replaces only the empty
 * folder just made. If someone has put something in it meanwhile the rename
 * fails: the folder is removed again if it is still empty, and the next name
 * is tried. `beforeRename` is for a test to act in that gap.
 */
async function publish(
  staging: string,
  folder: string,
  name: string,
  beforeRename?: (target: string) => void | Promise<void>,
): Promise<string> {
  for (let number = 1; number <= MAX_VARIANTS; number++) {
    const target = join(folder, unpackedName(name, number))
    try {
      await mkdir(target, { mode: DIRECTORY_MODE })
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue
      throw error
    }
    try {
      await beforeRename?.(target)
      await rename(staging, target)
      return target
    } catch (error) {
      await rmdir(target).catch(() => {})
      const code = errorCode(error)
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error
    }
  }
  throw new Error(`no free name for ${name}.unpacked after ${MAX_VARIANTS} tries`)
}

/**
 * Unpacks a saved archive into `<name>.unpacked/` beside it. A folder of that
 * name already there means it was unpacked before: nothing is written. Else
 * the archive is copied to a private file, judged and inspected again, and
 * walked into a staging folder (`.<random>.unpacking`) that becomes
 * `<name>.unpacked` only when everything has been written. Any failure
 * removes the staging folder, and the private copy goes in every case.
 */
export async function unpackArchive(request: UnpackRequest): Promise<Unpacked> {
  const { archivePath, name, type, folder, signal, limits } = request
  const existing = join(folder, unpackedName(name))
  if (await isFolder(existing)) return { path: existing, alreadyUnpacked: true }

  const staging = join(folder, privateName(".unpacking"))
  let copy: string | undefined
  try {
    const source = await openForRead(archivePath)
    const copied = await copyToPartial(source, folder, signal, ".unpack-source").finally(() => source.close())
    copy = copied.partial
    const kind = classifyFile({ name, type, head: copied.head })
    if (kind.kind !== "archive") throw new ArchiveRefused("no longer an archive that can be unpacked")
    await inspectArchive(copy, kind.format, limits, signal)

    await mkdir(staging, { mode: DIRECTORY_MODE })
    const stage = new Staging(staging)
    await walkArchive(
      copy,
      kind.format,
      async (entry, data) => {
        const problem = plainPathProblem(entry.name, entry.dir) ?? bundleProblem(entry.name)
        if (problem !== undefined) throw new ArchiveRefused(problem, cleanName(entry.name))
        const parts = entry.name.replace(/\/$/, "").split("/")
        if (data === null) await stage.directory(parts)
        else await stage.file(parts, data, signal)
      },
      limits,
      signal,
    )
    return { path: await publish(staging, folder, name, request.beforeRename), alreadyUnpacked: false }
  } catch (error) {
    await discard(staging)
    throw error
  } finally {
    if (copy !== undefined) await discard(copy)
  }
}
