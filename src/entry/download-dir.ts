import { resolve } from "node:path"
import { homeDir, resolveGivenDirectory, type GivenDirectory } from "./directory"
import type { EntryProfile } from "./profile"

/** The folder of a person's downloads under their home directory. */
const DOWNLOADS_DIR = "Downloads"

/**
 * Resolves the absolute path to the directory received files are saved under.
 *
 * Expands a leading `~` in the given text; when none is given, falls back to
 * `<home>/Downloads/<profile.name>`, where a person looks for what they downloaded.
 */
export function resolveDownloadDir(
  given: GivenDirectory | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): string {
  const home = homeDir(env)
  return given !== undefined ? resolveGivenDirectory(given, home) : resolve(home, DOWNLOADS_DIR, profile.name)
}
