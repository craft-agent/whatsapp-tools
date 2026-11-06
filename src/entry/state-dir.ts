import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { ToolError } from "../core"
import type { EntryProfile } from "./profile"

/** The user's home directory from `$HOME` (when absolute) or `os.homedir()`. */
function homeDir(env: Record<string, string | undefined>): string {
  const envHome = env.HOME
  if (envHome && isAbsolute(envHome)) return envHome
  return homedir()
}

/** Expands a leading `~` or `~/` against the user's home directory. */
function expandTilde(text: string, home: string): string {
  if (text === "~") return home
  if (text.startsWith("~/") || text.startsWith(`~${sep}`)) {
    return join(home, text.slice(2))
  }
  return text
}

/**
 * Resolves the absolute path to the directory where every account's state lives.
 *
 * Expands a leading `~` in the given text; when none is given, falls back to
 * `$XDG_STATE_HOME/<profile.name>` (when absolute) or `<home>/.local/state/<profile.name>`.
 */
export function resolveStateDir(
  given: { text: string; source: string } | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): string {
  const home = homeDir(env)

  if (given !== undefined) {
    const text = given.text.trim()
    const expanded = expandTilde(text, home)
    if (!text || !isAbsolute(expanded)) {
      throw new ToolError("invalid_argument", `${given.source} must be an absolute path.`)
    }
    return resolve(expanded)
  }

  const xdg = env.XDG_STATE_HOME
  if (xdg && isAbsolute(xdg)) {
    return resolve(xdg, profile.name)
  }

  return resolve(home, ".local", "state", profile.name)
}
