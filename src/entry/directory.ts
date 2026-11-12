import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import type { ToolOptions, ToolOptionValue } from "../core"

/** The folder of a person's downloads under their home directory. */
const DOWNLOADS_DIR = "Downloads"

/** The directories the settings name, resolved to absolute paths. */
export type DirectorySettings = { state_dir: string; download_dir: string; send_dirs: string[] }

/** The user's home directory from `$HOME` (when absolute) or `os.homedir()`. */
function homeDir(env: Record<string, string | undefined>): string {
  const envHome = env.HOME
  if (envHome && isAbsolute(envHome)) return envHome
  return homedir()
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
export function toolDirectories(settings: DirectorySettings): ToolDirectories {
  return { stateDir: settings.state_dir, downloadDir: settings.download_dir, sendDirs: settings.send_dirs }
}
