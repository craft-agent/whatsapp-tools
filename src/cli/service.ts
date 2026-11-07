import { realpathSync } from "node:fs"
import { ToolError } from "../core"
import { checkLabel, labelPaths, listLabels, pickLabel } from "../core/whatsapp/labels"
import {
  defaultServiceHost,
  installService,
  serviceStatus,
  uninstallService,
  type ServiceHost,
  type ServiceSpec,
} from "../core/whatsapp/service"
import { checkSession } from "../core/whatsapp/sync-session"
import { PROJECT } from "../project"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, usageError } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"

/** The reverse-DNS prefix the system knows the sync services by. */
export const SERVICE_ID = "io.github.craft-agent.whatsapp-tools"

const WINDOWS_TRACKING_URL = "https://github.com/craft-agent/whatsapp-tools/issues/11"

type ServiceAction = "install" | "uninstall" | "status"

type ServiceCommandArgs = {
  action: ServiceAction
  label?: string
  stateDir: string
}

function parseServiceArgs(argv: string[], io: CommandIo): ServiceCommandArgs {
  const args = argv[0] === "service" ? argv.slice(1) : argv
  const action = args[0]
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    const given = action === undefined ? "No service command given" : `Unknown service command "${action}"`
    throw usageError(`${given}; use service install|uninstall|status.`)
  }

  const { values, rest } = parseFlagArgs(args.slice(1), { values: ["--account"] })
  const account = values["--account"]
  return {
    action,
    label: account !== undefined ? checkLabel(account) : undefined,
    stateDir: parseCommandStateDir(rest, io),
  }
}

function resolveSelf(self?: CommandIo["self"]): NonNullable<CommandIo["self"]> {
  const program = self?.program ?? process.execPath
  let script = self?.script
  if (!script) {
    const raw = process.argv[1] ?? ""
    try {
      script = raw ? realpathSync(raw) : ""
    } catch {
      script = raw
    }
  }
  return { program, script }
}

async function resolveLabel(label: string | undefined, stateDir: string): Promise<string> {
  if (label !== undefined) return label

  const labels = await listLabels(stateDir)
  if (labels.length > 1) {
    throw usageError(`Several WhatsApp accounts are paired; name one with --account: ${labels.join(", ")}.`)
  }

  const paths = await pickLabel(stateDir, undefined)
  return paths.label
}

/** Refuses a label whose device is not paired, or whose session WhatsApp revoked: a service for it would stop at once. */
async function checkPaired(stateDir: string, label: string, io: CommandIo): Promise<void> {
  const state = await checkSession(labelPaths(stateDir, label), io.env, io.signal ?? new AbortController().signal)
  if (state !== "ok") {
    throw new ToolError(
      "invalid_argument",
      `This label has no usable pairing; pair it first with: ${PROJECT.cli} pair --account ${label}`,
    )
  }
}

/**
 * Runs the `service` command to install, uninstall, or query the background sync service.
 */
export async function runServiceCommand(argv: string[], io: CommandIo): Promise<number> {
  const host: ServiceHost = io.serviceHost ?? defaultServiceHost()

  let parsed: ServiceCommandArgs
  try {
    parsed = parseServiceArgs(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }

  let label: string
  try {
    label = await resolveLabel(parsed.label, parsed.stateDir)
  } catch (error) {
    return handleCommandError(error, io, { mode: "auto" })
  }

  try {
    if (parsed.action === "install") {
      await checkPaired(parsed.stateDir, label, io)

      const self = resolveSelf(io.self)
      const spec: ServiceSpec = {
        id: SERVICE_ID,
        label,
        program: self.program,
        args: [self.script, "sync", "--account", label, "--state-dir", parsed.stateDir],
        path: io.env.PATH ?? process.env.PATH ?? "",
      }

      const result = await installService(spec, host)
      io.stdout(`Installed sync service for "${label}" (${result.file}).\n`)
      if (result.log) {
        const logMsg =
          host.platform === "darwin" ? `Logs are written to: ${result.log}` : `View logs with: ${result.log}`
        io.stdout(`${logMsg}\n`)
      }
      io.stdout("The service starts automatically at logon and restarts after a failure.\n")
      io.stdout("Install the service again after updating this package, as it records the package path.\n")
      if (host.platform === "linux") {
        io.stdout('Run "loginctl enable-linger" to keep the service running while logged out.\n')
      }
      return EXIT_OK
    }

    if (parsed.action === "uninstall") {
      await uninstallService(SERVICE_ID, label, host)
      io.stdout(`Uninstalled sync service for "${label}".\n`)
      return EXIT_OK
    }

    const status = await serviceStatus(SERVICE_ID, label, host)
    io.stdout(`Sync service for "${label}":\n`)
    io.stdout(`  Installed: ${status.installed ? "yes" : "no"}\n`)
    io.stdout(`  Running: ${status.running ? "yes" : "no"}\n`)
    if (status.pid !== undefined) {
      io.stdout(`  PID: ${status.pid}\n`)
    }
    if (status.lastExit !== undefined) {
      io.stdout(`  Last exit: ${status.lastExit}\n`)
    }
    io.stdout(`  File: ${status.file}\n`)
    if (status.log) {
      io.stdout(`  Log: ${status.log}\n`)
    }
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, {
      abortMessage: "Service command was cancelled.",
      formatMessage(msg) {
        if (host.platform === "win32" && msg.includes("not supported on Windows")) {
          return `${msg} Windows support is tracked in ${WINDOWS_TRACKING_URL}.`
        }
        return msg
      },
    })
  }
}
