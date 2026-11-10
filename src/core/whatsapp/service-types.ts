import { homedir } from "node:os"
import { setTimeout } from "node:timers/promises"
import { ToolError } from "../errors"
import { exec, type ExecResult } from "../exec"
import { maskNumbers } from "./mask"

/** How much of a program's stderr is kept in an upstream_error message. */
const MAX_PROGRAM_ERROR_LENGTH = 300

/** How long a service management command may run before timing out. */
const DEFAULT_RUN_TIMEOUT_MS = 30_000

/** What names one service across its labels. */
export type ServiceName = {
  /** The reverse-DNS prefix for the service, e.g. "io.github.craft-agent.whatsapp-tools". */
  id: string
  /**
   * The file name the launcher script is given, before `-<label>`; the agent is
   * listed under it where the platform names background items after their program.
   */
  launcher: string
}

/** The specification for installing the sync service for one label. */
export type ServiceSpec = ServiceName & {
  /** The account label this service syncs for. */
  label: string
  /** The absolute path to the node runtime binary. */
  program: string
  /** The command-line arguments to run sync. */
  args: string[]
  /** The PATH environment variable value for the service. */
  path: string
}

/** The host environment running the service commands. */
export type ServiceHost = {
  /** The host platform ("darwin", "linux", etc.). */
  platform: NodeJS.Platform
  /** The user's home directory. */
  home: string
  /** The user id under which user-level agents run. */
  uid: number
  /** Environment variables. */
  env: Record<string, string | undefined>
  /** Executes a command with timeout. */
  run(argv: string[]): Promise<ExecResult>
  /** Waits between polls; defaults to a timer. Tests pass one that returns at once. */
  sleep?(ms: number): Promise<void>
}

/** The status of the sync service for one label. */
export type ServiceStatus = {
  /** Whether the service definition file exists on disk. */
  installed: boolean
  /** Whether the service is currently running. */
  running: boolean
  /** The process ID of the running service, when available. */
  pid?: number
  /** The exit code from the most recent run, when available. */
  lastExit?: number
  /** The service definition file path. */
  file: string
  /** Where to find or read the logs (file path on macOS, journalctl command on Linux). */
  log?: string
}

/**
 * Maps a failed program result to a `ToolError` with code `upstream_error`,
 * naming the program and its masked, truncated stderr.
 */
export function mapProgramError(program: string, result: ExecResult): ToolError {
  const masked = maskNumbers(result.stderr).trim().slice(0, MAX_PROGRAM_ERROR_LENGTH)
  const detail = masked ? `: ${masked}` : "."
  return new ToolError("upstream_error", `${program} failed${detail}`)
}

/** Control characters (U+0000–U+001F, U+007F) which break line-oriented configs or XML. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/

/**
 * Refuses service specs where the program, an argument, or PATH contains control characters.
 */
export function checkServiceSpecControlChars(spec: ServiceSpec): void {
  if (CONTROL_CHARACTERS.test(spec.program)) {
    throw new ToolError("invalid_argument", "Control characters are not allowed in the program.")
  }
  for (const arg of spec.args) {
    if (CONTROL_CHARACTERS.test(arg)) {
      throw new ToolError("invalid_argument", "Control characters are not allowed in an argument.")
    }
  }
  if (CONTROL_CHARACTERS.test(spec.path)) {
    throw new ToolError("invalid_argument", "Control characters are not allowed in PATH.")
  }
}

/** A launcher name safe as a file name: it starts with a letter or digit and holds no separator. */
const LAUNCHER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Refuses a launcher name that is not a plain file name. */
export function checkLauncherName(name: string): void {
  if (!LAUNCHER_NAME.test(name)) {
    throw new ToolError(
      "invalid_argument",
      "The launcher name may hold only letters, digits, dots, hyphens and underscores, and must start with a letter or digit.",
    )
  }
}

/** Default host environment for service management. */
export function defaultServiceHost(): ServiceHost {
  const env = process.env
  return {
    platform: process.platform,
    home: homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    env,
    sleep: (ms) => setTimeout(ms),
    run(argv: string[]): Promise<ExecResult> {
      const explicitEnv: Record<string, string> = {}
      for (const name of ["PATH", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
        const val = env[name]
        if (val !== undefined) explicitEnv[name] = val
      }
      return exec(argv, { env: explicitEnv, timeoutMs: DEFAULT_RUN_TIMEOUT_MS })
    },
  }
}
