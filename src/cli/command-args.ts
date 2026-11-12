import { isAbortError, isToolError, ToolError } from "../core"
import { directorySettings } from "../entry/directory"
import { PROJECT_PROFILE } from "../entry/profile"
import { parseToolOptions } from "../entry/settings"
import { PROJECT } from "../project"
import { EXIT_FAILED, EXIT_USAGE, type CommandIo } from "./command-io"

/** The one package setting the commands that select no tools take. */
const STATE_DIR_OPTION = "state_dir"

/** Specification of allowed flags for command-line argument parsing. */
export type FlagParserSpec<V extends string = string, S extends string = string> = {
  values?: readonly V[]
  switches?: readonly S[]
}

/** Result of parsing command-line flags. */
export type ParsedFlagArgs<V extends string, S extends string> = {
  values: Partial<Record<V, string>>
  switches: Set<S>
  rest: string[]
}

/** Creates an `invalid_argument` ToolError for command-line usage errors. */
export function usageError(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Prints an error message prefixed with the CLI program name to standard error. */
export function printCommandError(io: CommandIo, message: string): void {
  io.stderr(`${PROJECT.cli}: ${message}\n`)
}

/** Options for handling command errors. */
export type CommandErrorOptions = {
  /** Optional message to print when an AbortError occurs. */
  abortMessage?: string
  /** Optional formatter to modify or annotate the error message. */
  formatMessage?: (message: string) => string
  /**
   * How to determine the exit code on ToolError:
   * - "failed": always EXIT_FAILED (default, used for command execution)
   * - "usage": always EXIT_USAGE (used for flag parsing)
   * - "auto": EXIT_USAGE if code is "invalid_argument", else EXIT_FAILED (used for label resolution)
   */
  mode?: "failed" | "usage" | "auto"
}

/** Prints a tool or abort error and returns the appropriate exit code, or rethrows unexpected errors. */
export function handleCommandError(error: unknown, io: CommandIo, options?: CommandErrorOptions): number {
  if (isToolError(error)) {
    const message = options?.formatMessage ? options.formatMessage(error.message) : error.message
    printCommandError(io, message)
    const mode = options?.mode ?? "failed"
    if (mode === "usage") return EXIT_USAGE
    if (mode === "auto") return error.code === "invalid_argument" ? EXIT_USAGE : EXIT_FAILED
    return EXIT_FAILED
  }
  if (options?.abortMessage && isAbortError(error)) {
    printCommandError(io, options.abortMessage)
    return EXIT_FAILED
  }
  throw error
}

/**
 * Parses value flags (`--flag value` / `--flag=value`) and boolean switch flags (`--flag`),
 * collecting unhandled arguments into `rest`.
 */
export function parseFlagArgs<V extends string = string, S extends string = string>(
  argv: string[],
  spec: FlagParserSpec<V, S>,
): ParsedFlagArgs<V, S> {
  const values: Partial<Record<V, string>> = {}
  const switches = new Set<S>()
  const rest: string[] = []

  const valueFlags = new Set(spec.values ?? [])
  const switchFlags = new Set(spec.switches ?? [])

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.indexOf("=")
    const flag = equals === -1 ? arg : arg.slice(0, equals)

    if (valueFlags.has(flag as V)) {
      const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
      if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) {
        throw usageError(`Option ${flag} needs a value.`)
      }
      values[flag as V] = value
    } else if (switchFlags.has(flag as S)) {
      if (equals !== -1) throw usageError(`Option ${flag} takes no value.`)
      switches.add(flag as S)
    } else {
      rest.push(arg)
    }
  }

  return { values, switches, rest }
}

/**
 * Resolves the state directory from remaining command-line arguments and environment settings. It is the only
 * setting these commands take: the flag of any other is `invalid_argument`.
 */
export function parseCommandStateDir(rest: string[], io: CommandIo): string {
  const profile = io.profile ?? PROJECT_PROFILE
  const options = Object.entries(profile.options ?? {}).filter(([name]) => name === STATE_DIR_OPTION)
  const stateOnly = { ...profile, options: Object.fromEntries(options) }
  return directorySettings(parseToolOptions(rest, io.env, stateOnly), io.env, profile).state_dir
}
