import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { ToolError, type ToolOptions, type ToolOptionValue } from "../core"

/** The folder of a person's downloads under their home directory. */
const DOWNLOADS_DIR = "Downloads"

/** A directory setting given as text, and where it came from, for error messages. */
export type GivenDirectory = { text: string; source: string }

/** The directories the settings name, resolved to absolute paths. */
export type DirectorySettings = { state_dir: string; download_dir: string; send_dirs: string[] }

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

function pathOf(value: ToolOptionValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function pathsOf(value: ToolOptionValue | undefined): readonly string[] {
  return typeof value === "object" ? value : []
}

/**
 * The directories the package's own `path` and `paths` settings name, with
 * the defaults filled in for those not given. `options` holds the settings as
 * `parseToolOptions` returns them, so every given path is absolute and
 * normalized already.
 *
 * - `state_dir`: `$XDG_STATE_HOME/<profile.name>` (when absolute), else
 *   `<home>/.local/state/<profile.name>`.
 * - `download_dir`: `<home>/Downloads/<profile.name>`, where a person looks
 *   for what they downloaded.
 * - `send_dirs`: none; a directory named twice is kept once, in the order
 *   first given.
 *
 * The home directory is `$HOME` (when absolute), else the user's.
 */
export function directorySettings(
  options: ToolOptions,
  env: Record<string, string | undefined>,
  profile: { name: string },
): DirectorySettings {
  const home = homeDir(env)
  const xdg = env.XDG_STATE_HOME
  const stateHome = xdg && isAbsolute(xdg) ? xdg : resolve(home, ".local", "state")
  return {
    state_dir: pathOf(options.state_dir) ?? resolve(stateHome, profile.name),
    download_dir: pathOf(options.download_dir) ?? resolve(home, DOWNLOADS_DIR, profile.name),
    send_dirs: [...new Set(pathsOf(options.send_dirs))],
  }
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
