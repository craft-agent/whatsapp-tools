import { realpath } from "node:fs/promises"
import { dirname } from "node:path"
import { containing } from "./inside"

/** What `allowedRoots` is given. */
export type RootsInput = {
  /** The working directory: allowed unless it is the home directory or a file system root, which would open everything the user owns. */
  cwd: string
  /** Directories the user named; each that exists is allowed, the home directory and a file system root included. */
  sendDirs: readonly string[]
  /** The home directory. */
  home: string
  /** Directories nothing may be sent from (the state directory, the tools' own directory); a root inside one is dropped. */
  forbidden: readonly string[]
}

async function realPathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

/**
 * The real paths of the directories files may be sent from: the working
 * directory, unless its real path is the home directory's or a file system
 * root's, and each directory in `sendDirs`. A directory that cannot be
 * resolved (it does not exist) is skipped, and one inside a `forbidden`
 * directory is dropped. Links are resolved, so what is judged later is where
 * a path really leads. The order is the working directory first, then
 * `sendDirs` as given, with a directory named twice kept once.
 */
export async function allowedRoots({ cwd, sendDirs, home, forbidden }: RootsInput): Promise<string[]> {
  const roots = new Set<string>()
  const workingDir = await realPathOrUndefined(cwd)
  if (workingDir !== undefined) {
    const homeDir = (await realPathOrUndefined(home)) ?? home
    if (workingDir !== homeDir && dirname(workingDir) !== workingDir) roots.add(workingDir)
  }
  for (const directory of sendDirs) {
    const real = await realPathOrUndefined(directory)
    if (real !== undefined) roots.add(real)
  }
  const allowed: string[] = []
  for (const root of roots) if ((await containing(root, forbidden)) === undefined) allowed.push(root)
  return allowed
}
