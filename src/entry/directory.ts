import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { ToolError } from "../core"

/** A directory setting given as text, and where it came from, for error messages. */
export type GivenDirectory = { text: string; source: string }

/** The user's home directory from `$HOME` (when absolute) or `os.homedir()`. */
export function homeDir(env: Record<string, string | undefined>): string {
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

/** Resolves a directory setting to an absolute path after expanding a leading `~`; anything else is `invalid_argument` naming the source. */
export function resolveGivenDirectory(given: GivenDirectory, home: string): string {
  const text = given.text.trim()
  const expanded = expandTilde(text, home)
  if (!text || !isAbsolute(expanded)) {
    throw new ToolError("invalid_argument", `${given.source} must be an absolute path.`)
  }
  return resolve(expanded)
}

/** The directory properties an entry point passes to `ToolContext`. */
export type ToolDirectories = { stateDir: string; downloadDir: string; sendDirs: string[] }

/** Maps resolved directory settings to the properties of `ToolContext`. */
export function toolDirectories(settings: {
  state_dir: string
  download_dir: string
  send_dirs: string[]
}): ToolDirectories {
  return { stateDir: settings.state_dir, downloadDir: settings.download_dir, sendDirs: settings.send_dirs }
}
