import { isToolError } from "../core"
import { checkLabel } from "../core/whatsapp/labels"
import { removeLabel } from "../core/whatsapp/removal"
import { defaultServiceHost, uninstallService } from "../core/whatsapp/service"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, printCommandError, usageError } from "./command-args"
import { defaultReadLine, EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { SERVICE_ID } from "./service"

type RemoveArgs = {
  label: string
  yes: boolean
  stateDir: string
}

function parseRemoveArgs(argv: string[], io: CommandIo): RemoveArgs {
  const args = argv[0] === "remove" ? argv.slice(1) : argv
  const { values, switches, rest } = parseFlagArgs(args, {
    values: ["--account"],
    switches: ["--yes"],
  })
  const stateDir = parseCommandStateDir(rest, io)

  const account = values["--account"]
  if (account === undefined) {
    throw usageError("Option --account is required.")
  }

  return {
    label: checkLabel(account),
    yes: switches.has("--yes"),
    stateDir,
  }
}

/**
 * Runs the `remove` command to permanently delete an account's state directory:
 * the person types the label back first unless `--yes` is given. The sync
 * service is uninstalled, the device is logged out of WhatsApp when it can be,
 * and the directory is deleted. Resolves to the exit code.
 */
export async function runRemoveCommand(argv: string[], io: CommandIo): Promise<number> {
  let parsed: RemoveArgs
  try {
    parsed = parseRemoveArgs(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }

  const { label, yes, stateDir } = parsed

  if (!yes) {
    const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY)
    if (!isTTY) {
      printCommandError(io, "Removing an account without a terminal requires --yes.")
      return EXIT_USAGE
    }

    io.stdout(`This will permanently delete the keys, wacli's store and the message history for "${label}".\n`)
    const prompt = `To confirm, please type the label name "${label}": `
    const readLine = io.readLine ?? defaultReadLine
    const answer = await readLine(prompt)
    if (answer?.trim() !== label) {
      printCommandError(io, "Removal cancelled.")
      return EXIT_FAILED
    }
  }

  try {
    const host = io.serviceHost ?? defaultServiceHost()
    const { loggedOut } = await removeLabel({
      stateDir,
      label,
      env: io.env,
      signal: io.signal,
      uninstall: async () => {
        try {
          await uninstallService(SERVICE_ID, label, host)
        } catch (error) {
          // On unsupported platforms, services cannot be installed so removal may proceed.
          if (isToolError(error) && error.code === "invalid_argument") {
            return
          }
          throw error
        }
      },
    })

    io.stdout(`Removed "${label}".\n`)
    if (loggedOut) {
      io.stdout("The device was logged out of WhatsApp.\n")
    } else {
      io.stdout("The device could not be logged out of WhatsApp; remove it on the phone: WhatsApp > Linked devices.\n")
    }
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Removal was cancelled." })
  }
}
