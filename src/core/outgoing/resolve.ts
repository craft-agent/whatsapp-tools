import { lstat, realpath } from "node:fs/promises"
import { basename, resolve, sep } from "node:path"
import { ToolError } from "../errors"
import { errorCode } from "../file/fs-safe"
import { deniedHomePlace, isDeniedFolder, isDeniedName } from "./deny-lists"
import { hardLinked, identityOf, type FileIdentity } from "./identity"
import { containing } from "./inside"

/** What `resolveOutgoing` is given. */
export type ResolveInput = {
  /** The working directory a relative path is read against. */
  cwd: string
  /** The real paths files may be sent from (`allowedRoots`). */
  roots: readonly string[]
  /** Directories nothing may be sent from, whichever root contains them (the state directory, the tools' own directory). */
  forbidden: readonly string[]
  /** The home directory, whose browser profiles, password managers, chat clients and backups are never sent from. */
  home: string
}

/** The file a path really leads to, and the root that allows it. */
export type ResolvedOutgoing = {
  /** The real path, with every link resolved. */
  realPath: string
  /** The file's own name, as the real path ends. */
  name: string
  /** The first of `roots` that contains the file. */
  root: string
  /** Which file this is, for `assertResolvedFile` to check on the descriptor that is opened. */
  identity: FileIdentity
}

const UNRESOLVABLE = new Set(["ENOENT", "ENOTDIR", "ELOOP"])
const UNREADABLE = new Set(["EACCES", "EPERM"])

async function realPathOf(path: string, shown: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    const code = errorCode(error) ?? ""
    if (UNRESOLVABLE.has(code)) throw new ToolError("not_found", `${shown} does not exist.`, { cause: error })
    if (UNREADABLE.has(code)) throw new ToolError("forbidden", `${shown} cannot be read.`, { cause: error })
    throw error
  }
}

/**
 * Judges a local file that is about to leave, by where it really is and what
 * it is called, before any of it is read. `path` is absolute or relative to
 * `cwd`; a leading `~` is not expanded (a path is taken as written). It is
 * judged first as a file: a regular file, else `invalid_argument`, with one
 * name only, since a hard link (`nlink > 1`) is `forbidden` (`hardLinked`
 * says why). That comes before anything about where it is, because `realpath`
 * of a hard link may name any of its names (macOS does). Its real path must
 * then:
 *
 * - lie inside none of `forbidden`, however a link led there, else `forbidden`;
 * - have no component, from the file system root down, that is a key or
 *   settings folder (`isDeniedFolder`; the message does not say which, as a
 *   link may have led through a folder the caller never named), and a name that does not look like a
 *   key or a secret (`isDeniedName`), else `forbidden`;
 * - not lie in a place below `home` that holds browser profiles, password
 *   managers, chat clients or backups (`deniedHomePlace`), else `forbidden`;
 * - lie inside one of `roots` (by path components, not by string prefix),
 *   else `forbidden` saying the file is outside the directories files may be
 *   sent from and that a directory is added with `send_dirs`.
 *
 * Containment comes last on purpose: its advice is to add a directory, which
 * must never be given for a folder that can never be a source.
 *
 * A path that does not exist is `not_found`. Messages name only `path`, as it
 * was given. `identity` lets the caller check, on the descriptor it opens,
 * that it is still this file (`assertResolvedFile`).
 *
 * Containment compares real paths from `realpath`, which gives the case a
 * path has on disk where the file system ignores case (checked on macOS), so
 * a path written in another case is judged by the case it really has.
 */
export async function resolveOutgoing(
  path: string,
  { cwd, roots, forbidden, home }: ResolveInput,
): Promise<ResolvedOutgoing> {
  const shown = JSON.stringify(path)
  const real = await realPathOf(resolve(cwd, path), shown)
  const stats = await lstat(real, { bigint: true })
  if (!stats.isFile()) throw new ToolError("invalid_argument", `${shown} is not a regular file.`)
  if (stats.nlink > 1n) throw hardLinked(shown)

  if ((await containing(real, forbidden)) !== undefined) {
    throw new ToolError("forbidden", `${shown} is inside a directory that is never a source of files.`)
  }
  if (real.split(sep).some((component) => component !== "" && isDeniedFolder(component))) {
    throw new ToolError("forbidden", `${shown} is inside a key or settings folder.`)
  }
  const name = basename(real)
  if (isDeniedName(name)) {
    throw new ToolError("forbidden", `${shown} is named like a key or a secret, which are never sent.`)
  }
  const place = deniedHomePlace(real, await realpath(home).catch(() => home))
  if (place !== undefined) {
    throw new ToolError("forbidden", `${shown} is inside a place that holds logins, cookies or messages (${place}).`)
  }
  const root = await containing(real, roots)
  if (root === undefined) {
    throw new ToolError(
      "forbidden",
      `${shown} is outside the directories files may be sent from (the working directory and the send_dirs setting); add the directory it is in to send_dirs.`,
    )
  }
  return { realPath: real, name, root, identity: identityOf(stats) }
}
