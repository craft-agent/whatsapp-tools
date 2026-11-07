import { isAbsolute, resolve } from "node:path"
import { homeDir, resolveGivenDirectory, type GivenDirectory } from "./directory"
import type { EntryProfile } from "./profile"

/**
 * Resolves the absolute path to the directory where every account's state lives.
 *
 * Expands a leading `~` in the given text; when none is given, falls back to
 * `$XDG_STATE_HOME/<profile.name>` (when absolute) or `<home>/.local/state/<profile.name>`.
 */
export function resolveStateDir(
  given: GivenDirectory | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): string {
  const home = homeDir(env)

  if (given !== undefined) return resolveGivenDirectory(given, home)

  const xdg = env.XDG_STATE_HOME
  if (xdg && isAbsolute(xdg)) {
    return resolve(xdg, profile.name)
  }

  return resolve(home, ".local", "state", profile.name)
}
