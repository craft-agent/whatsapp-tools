import {
  annotations,
  inputJsonSchema,
  invoke,
  isAbortError,
  isToolError,
  outputJsonSchema,
  selectTools,
  ToolError,
  type ErrorCode,
  type ErrorDetails,
  type ToolSpec,
} from "../core"
import { permissionDescription } from "../entry/description"
import { errorBody } from "../entry/errors"
import { permissionResources } from "../entry/permission"
import { PROJECT_PROFILE, type EntryProfile } from "../entry/profile"
import { parseDirectorySettings, parseToolSettings, toolDirectories, type ToolDirectories } from "../entry/settings"
import { PROJECT } from "../project"
import { usageError } from "./command-args"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { runPair } from "./pair"
import { runRemoveCommand } from "./remove"
import { runServiceCommand } from "./service"
import { runSyncCommand } from "./sync"

export { EXIT_FAILED, EXIT_OK, EXIT_USAGE }

const PROGRAM = PROJECT.cli
const CWD_FLAG = "--cwd"

/** What a command line needs from its surroundings; `main.ts` wires the process, a test supplies its own. */
export type CliIo = {
  /** The tools the command line can select from. */
  specs: ToolSpec[]
  /** Where the `<envPrefix>_*` settings fall back to. */
  env: Record<string, string | undefined>
  /** The settings' environment prefix and the toolsets; defaults to this package's. */
  profile?: EntryProfile
  /** Reads standard input to its end; an empty string when there is none. */
  readStdin(): Promise<string>
  /** Receives the JSON document a command answers with. */
  stdout(text: string): void
  /** Receives usage lines and the detail of unexpected errors. */
  stderr(text: string): void
  /** Where the tools are installed: never a call's working tree. */
  ownDir?: string
  /** Stops a running tool when it aborts. */
  signal?: AbortSignal
  /** How long a call's description may take; defaults to DESCRIBE_TIMEOUT_MS. */
  describeTimeoutMs?: number
}

type Command =
  | { name: "list"; selected: ToolSpec[] }
  | { name: "run"; toolId: string; cwd: string; selected: ToolSpec[]; directories: ToolDirectories }
  | { name: "target"; toolId: string; cwd: string; directories: ToolDirectories }

/** Splits `--cwd <dir>` from the remaining arguments, which are the settings flags. */
function takeCwd(argv: string[]): { cwd: string | undefined; rest: string[] } {
  let cwd: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith(`${CWD_FLAG}=`)) {
      cwd = arg.slice(CWD_FLAG.length + 1)
    } else if (arg === CWD_FLAG) {
      cwd = argv[++i]
      if (cwd === undefined || cwd.startsWith("--")) throw usageError(`Option ${CWD_FLAG} needs a value.`)
    } else {
      rest.push(arg)
    }
  }
  if (cwd === "") throw usageError(`Option ${CWD_FLAG} needs a value.`)
  return { cwd, rest }
}

/** Reads the command line; a mistake in it, in the settings or in the tool selection is `invalid_argument`. */
function parseCommand(argv: string[], io: Pick<CliIo, "specs" | "env" | "profile">): Command {
  const profile = io.profile ?? PROJECT_PROFILE
  const [name, ...args] = argv
  if (name === "list") {
    return { name, selected: selectTools(io.specs, parseToolSettings(args, io.env, profile), profile.toolsets) }
  }
  if (name !== "run" && name !== "target") {
    const given = name === undefined ? "No command given" : `Unknown command "${name}"`
    throw usageError(
      `${given}; use list, run <tool-id> --cwd <dir>, target <tool-id> --cwd <dir>, pair, sync, service or remove.`,
    )
  }

  const [toolId, ...options] = args
  if (toolId === undefined || toolId.startsWith("--")) throw usageError(`Command ${name} needs a tool id.`)
  const { cwd, rest } = takeCwd(options)
  if (cwd === undefined) throw usageError(`Command ${name} needs ${CWD_FLAG} <dir>.`)
  if (name === "target") {
    return { name, toolId, cwd, directories: toolDirectories(parseDirectorySettings(rest, io.env, profile)) }
  }

  const settings = parseToolSettings(rest, io.env, profile)
  return {
    name,
    toolId,
    cwd,
    selected: selectTools(io.specs, settings, profile.toolsets),
    directories: toolDirectories(settings),
  }
}

function describeSpec(spec: ToolSpec) {
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    toolset: spec.toolset,
    class: spec.class,
    annotations: annotations(spec),
    input_schema: inputJsonSchema({ input: spec.input.strict() }),
    output_schema: outputJsonSchema(spec),
  }
}

function writeJson(io: CliIo, document: unknown): void {
  io.stdout(`${JSON.stringify(document)}\n`)
}

function writeError(io: CliIo, code: ErrorCode, message: string, details?: Readonly<ErrorDetails>): number {
  writeJson(io, { error: errorBody(code, message, details) })
  return EXIT_FAILED
}

/** The arguments a command reads from standard input: one JSON object, or none at all. */
async function readArguments(io: CliIo): Promise<unknown> {
  const text = await io.readStdin()
  if (text.trim() === "") return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ToolError("invalid_argument", "The arguments on standard input are not valid JSON.", { cause: error })
  }
}

async function runTool(command: Extract<Command, { name: "run" }>, io: CliIo): Promise<number> {
  const spec = command.selected.find((candidate) => candidate.id === command.toolId)
  if (!spec) return writeError(io, "invalid_argument", `Unknown tool "${command.toolId}".`)
  try {
    const result = await invoke(spec, await readArguments(io), {
      cwd: command.cwd,
      ownDir: io.ownDir,
      ...command.directories,
      programName: PROJECT.name,
      signal: io.signal,
    })
    writeJson(io, { result })
    return EXIT_OK
  } catch (error) {
    if (isToolError(error)) return writeError(io, error.code, error.message, error.details)
    if (isAbortError(error)) return writeError(io, "internal_error", `${spec.id} was cancelled.`)
    io.stderr(`${PROGRAM}: unexpected error while running ${spec.id}: ${errorDetail(error)}\n`)
    return writeError(io, "internal_error", `Unexpected error while running ${spec.id}; see standard error.`)
  }
}

async function targetOf(command: Extract<Command, { name: "target" }>, io: CliIo): Promise<number> {
  const spec = io.specs.find((candidate) => candidate.id === command.toolId)
  if (!spec) return writeError(io, "invalid_argument", `Unknown tool "${command.toolId}".`)
  try {
    const args = await readArguments(io)
    const ctx = {
      cwd: command.cwd,
      ownDir: io.ownDir,
      ...command.directories,
      programName: PROJECT.name,
      signal: io.signal,
    }
    const [resources, description] = await Promise.all([
      permissionResources(spec, args, ctx),
      permissionDescription(spec, args, ctx, io.describeTimeoutMs),
    ])
    writeJson(io, description === undefined ? { resources } : { resources, description })
    return EXIT_OK
  } catch (error) {
    if (isToolError(error)) return writeError(io, error.code, error.message, error.details)
    if (isAbortError(error)) return writeError(io, "internal_error", "The call was cancelled.")
    io.stderr(`${PROGRAM}: unexpected error while resolving the target: ${errorDetail(error)}\n`)
    return writeError(io, "internal_error", "Unexpected error while resolving the target; see standard error.")
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/** The commands a person runs to set up an account, which print plain text rather than a JSON document. */
const PERSON_COMMANDS: Partial<Record<string, (argv: string[], io: CommandIo) => Promise<number>>> = {
  pair: runPair,
  sync: runSyncCommand,
  service: runServiceCommand,
  remove: runRemoveCommand,
}

/**
 * The command line of the package, for callers that are not a harness's own
 * plugin: `list` answers with the selected tools, `run` runs one with the
 * arguments on standard input, and `target` answers with what a call would
 * write to (`{"resources": [...]}`), plus a `description` when the tool gives
 * one: `{"facts": [...], "text"?: {"label", "body"}}`, as the approval prompt
 * shows it (hidden characters marked). Standard output carries only the JSON document; a
 * mistake in the command line is one line on standard error and `EXIT_USAGE`.
 * `pair`, `sync`, `service` and `remove` are for a person setting up an
 * account (see `PERSON_COMMANDS`). Resolves to the exit code.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [name, ...rest] = argv
  const personCommand = name !== undefined && Object.hasOwn(PERSON_COMMANDS, name) ? PERSON_COMMANDS[name] : undefined
  if (personCommand) return personCommand(rest, io)

  let command: Command
  try {
    command = parseCommand(argv, io)
  } catch (error) {
    if (!isToolError(error)) throw error
    io.stderr(`${PROGRAM}: ${error.message}\n`)
    return EXIT_USAGE
  }

  switch (command.name) {
    case "list":
      writeJson(io, command.selected.map(describeSpec))
      return EXIT_OK
    case "run":
      return runTool(command, io)
    case "target":
      return targetOf(command, io)
  }
}
