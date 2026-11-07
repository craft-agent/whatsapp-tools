import { createHash, randomBytes } from "node:crypto"
import { link, lstat, rm, unlink, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import { CLASSIFY_HEAD_BYTES } from "../archive/kind"
import { copyAll, createNew, errorCode, openForRead, sha256Of } from "./fs-safe"
import { FILE_MODE } from "./constants"
import { numberedName } from "./names"

/** How many names, the first and then numbered ones, are tried for a file before giving up. */
const MAX_VARIANTS = 1000

/** The errors of `link` for a file system that has no hard links (or none across the folder): a copy stands in. */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"])

/** A file copied into the folder under a name of its own, not yet placed. */
export type Copied = {
  /** Where the private copy is; it ends in `.partial` and starts with a dot. */
  partial: string
  size: number
  sha256: string
  /** The first bytes of the file, to judge what it is. */
  head: Buffer
  /** Which file the partial is, so that placing it can tell it was not swapped for another. */
  dev: number
  ino: number
}

/** Where a file ended up. */
export type Placed = { path: string; name: string; alreadySaved: boolean }

/** A name nobody else is likely to pick, for a file that is on its way: `.<random><suffix>`. */
export function privateName(suffix: string): string {
  return `.${randomBytes(8).toString("hex")}${suffix}`
}

/** Removes a path and anything below it, links not followed; it is fine if it is gone. */
export async function discard(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/**
 * Copies a file into `folder` as a new private file (`.<random>.partial`
 * unless another `suffix` is given, 0600), computing its SHA-256 and keeping
 * its first bytes on the way. The copy is removed again if it fails.
 */
export async function copyToPartial(
  source: FileHandle,
  folder: string,
  signal?: AbortSignal,
  suffix = ".partial",
): Promise<Copied> {
  const partial = join(folder, privateName(suffix))
  const target = await createNew(partial)
  const hash = createHash("sha256")
  const head: Buffer[] = []
  let kept = 0
  try {
    const size = await copyAll(
      source,
      target,
      (chunk) => {
        hash.update(chunk)
        if (kept < CLASSIFY_HEAD_BYTES) {
          const part = Buffer.from(chunk.subarray(0, CLASSIFY_HEAD_BYTES - kept))
          head.push(part)
          kept += part.length
        }
      },
      signal,
    )
    const { dev, ino } = await target.stat()
    return { partial, size, sha256: hash.digest("hex"), head: Buffer.concat(head), dev, ino }
  } catch (error) {
    await discard(partial)
    throw error
  } finally {
    await target.close().catch(() => {})
  }
}

/**
 * Whether the path holds a file this tool would have made from `copied`: an
 * ordinary file (a link is not one), owned by the current user, mode exactly
 * 0600, of this size and SHA-256. The same bytes under another owner or mode
 * are not that file; it is neither reused nor changed.
 */
async function isSavedCopy(path: string, copied: Copied): Promise<boolean> {
  try {
    const found = await lstat(path)
    const mine = process.getuid === undefined || found.uid === process.getuid()
    return (
      found.isFile() &&
      mine &&
      (found.mode & 0o7777) === FILE_MODE &&
      found.size === copied.size &&
      (await sha256Of(path)) === copied.sha256
    )
  } catch {
    return false
  }
}

/** Refuses to place a partial that is no longer the file that was written: replaced, swapped or changed since. */
async function checkUnchanged(copied: Copied): Promise<void> {
  const found = await lstat(copied.partial)
  if (!found.isFile() || found.dev !== copied.dev || found.ino !== copied.ino || found.size !== copied.size) {
    throw new Error("the private copy changed before it was placed")
  }
}

/** Copies the partial to a name that is new, for a file system that cannot link; the copy is removed if it fails. */
async function copyExclusive(partial: string, path: string): Promise<void> {
  const target = await createNew(path)
  try {
    const source = await openForRead(partial)
    try {
      await copyAll(source, target, () => {})
    } finally {
      await source.close()
    }
  } catch (error) {
    await target.close().catch(() => {})
    await discard(path)
    throw error
  }
  await target.close()
  await unlink(partial)
}

/**
 * Puts the partial in `folder` under `name`, never over anything: it is
 * linked (or, on a file system without links, copied) to the name only if the
 * name is free. A name that is taken by a file this tool made (an ordinary
 * file of the current user, mode 0600, of the same size and SHA-256) is that
 * file already saved, and is reused; any other file, the same bytes at another
 * mode or owner included, or a link, sends the file to `name (2)`, `name (3)`, …
 * The partial is gone afterwards, and it must still be the file that was
 * written. Nothing already there is opened for writing or has its mode changed.
 */
export async function placeFile(copied: Copied, folder: string, name: string): Promise<Placed> {
  await checkUnchanged(copied)
  for (let number = 1; number <= MAX_VARIANTS; number++) {
    const candidate = number === 1 ? name : numberedName(name, number)
    const path = join(folder, candidate)
    try {
      try {
        await link(copied.partial, path)
        await unlink(copied.partial)
      } catch (error) {
        if (!NO_HARD_LINKS.has(errorCode(error) ?? "")) throw error
        await copyExclusive(copied.partial, path)
      }
      return { path, name: candidate, alreadySaved: false }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
      if (await isSavedCopy(path, copied)) {
        await discard(copied.partial)
        return { path, name: candidate, alreadySaved: true }
      }
    }
  }
  throw new Error(`no free name for ${name} after ${MAX_VARIANTS} tries`)
}
