import { isToolError } from "../core"
import { pickLabel } from "../core/whatsapp/labels"
import { serviceOperations } from "../core/whatsapp/operations"
import { runSync } from "../core/whatsapp/sync"
import { handleCommandError, parseCommandStateDir, parseFlagArgs } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"
import { localTimestamp } from "./local-time"

const ACCOUNT_FLAG = "--account"

/** What the service logs when there is no label to run for. */
const NOT_PAIRED_MESSAGE = "no WhatsApp account is paired; pair a device first"

type SyncCommand = {
  label: string
  stateDir: string
}

/** Reads the command line: `--account` and the settings flags, of which only the state directory is taken. */
async function parseSync(argv: string[], io: CommandIo): Promise<SyncCommand> {
  const { values, rest } = parseFlagArgs(argv, { values: [ACCOUNT_FLAG] })
  const stateDir = parseCommandStateDir(rest, io)
  return { label: (await pickLabel(stateDir, values[ACCOUNT_FLAG])).label, stateDir }
}

/** `<local time> <line>` on one line of standard error, for a service's log. */
function logLine(io: CommandIo): (line: string) => void {
  return (line) => io.stderr(`${localTimestamp(new Date())} ${line}\n`)
}

/**
 * The `sync` command: runs the sync service of one account in the foreground
 * (`--account`, or the only paired one): it keeps the account's mirror
 * current until it is stopped, and logs to standard error. Resolves to the
 * exit code: 0 on a stop request and when there is nothing to run (no paired
 * account, or WhatsApp revoked the session), 1 after any other failure, 2 for
 * a mistake in the command line (several accounts without `--account`
 * included).
 */
export async function runSyncCommand(argv: string[], io: CommandIo): Promise<number> {
  let command: SyncCommand
  try {
    command = await parseSync(argv, io)
  } catch (error) {
    // No such account is "not paired", which is nothing to run, not a failure to restart.
    if (isToolError(error) && error.code === "not_found") {
      logLine(io)(NOT_PAIRED_MESSAGE)
      return EXIT_OK
    }
    return handleCommandError(error, io, { mode: "auto" })
  }

  try {
    const outcome = await runSync({
      stateDir: command.stateDir,
      label: command.label,
      env: io.env,
      signal: io.signal ?? new AbortController().signal,
      log: logLine(io),
      operations: serviceOperations(),
    })
    return outcome.exitCode
  } catch (error) {
    return handleCommandError(error, io)
  }
}
