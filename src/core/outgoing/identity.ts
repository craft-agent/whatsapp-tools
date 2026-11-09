import type { BigIntStats } from "node:fs"
import { ToolError } from "../errors"

/** Which file on which device a path led to when it was resolved. */
export type FileIdentity = { dev: bigint; ino: bigint }

/**
 * The refusal for a file with more than one name. `realpath` resolves links
 * but cannot see a hard link's other names, so a file that is also named
 * inside a key or settings folder, or called `id_rsa`, could be reached under
 * an innocent name and pass the folder and name rules. Such a file is refused
 * whatever its names are. `shown` is the path as the caller gave it.
 */
export function hardLinked(shown: string): ToolError {
  return new ToolError(
    "forbidden",
    `${shown} has more than one name (a hard link), so where it really lives cannot be told.`,
  )
}

/** The identity of a file from its `lstat` or `fstat` taken with `{ bigint: true }`, whose numbers stay exact. */
export function identityOf(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino }
}

/**
 * Checks the `fstat` (taken with `{ bigint: true }`) of the file a caller
 * has opened against what `resolveOutgoing` resolved, since a path can be
 * replaced between resolving and opening. Throws `invalid_argument` for
 * anything but a regular file, `forbidden` for one with more than one name
 * (`hardLinked`) and `stale` for another file than the one resolved. `shown`
 * is the path as the caller gave it.
 */
export function assertResolvedFile(stats: BigIntStats, expected: FileIdentity, shown: string): void {
  if (!stats.isFile()) throw new ToolError("invalid_argument", `${shown} is not a regular file.`)
  if (stats.nlink > 1n) throw hardLinked(shown)
  if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
    throw new ToolError("stale", `${shown} changed between being checked and being opened; try again.`)
  }
}
