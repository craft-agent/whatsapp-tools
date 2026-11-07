import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExecResult } from "../exec"
import {
  checkServiceSpecControlChars,
  mapProgramError,
  type ServiceHost,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-types"

/** Quotes an argument for systemd ExecStart escaping `\`, `"`, `%` as `%%`, and `$` as `$$`. */
export function quoteSystemdArg(arg: string): string {
  const escaped = arg
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")
  return `"${escaped}"`
}

/** Builds the systemd service unit file content. */
export function buildSystemdUnit(spec: ServiceSpec): string {
  checkServiceSpecControlChars(spec)
  const allArgs = [spec.program, ...spec.args]
  const execStart = allArgs.map(quoteSystemdArg).join(" ")
  const escapedPath = spec.path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")

  return `[Unit]
Description=WhatsApp sync service (${spec.label})

[Service]
Type=simple
ExecStart=${execStart}
Environment="PATH=${escapedPath}"
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
`
}

function systemdPaths(id: string, label: string, host: ServiceHost) {
  const unitName = `${id.replaceAll(".", "-")}-${label}.service`
  const configHome = host.env.XDG_CONFIG_HOME || join(host.home, ".config")
  const unitDir = join(configHome, "systemd", "user")
  const unitPath = join(unitDir, unitName)
  const log = `journalctl --user -u ${unitName}`
  return { unitName, unitDir, unitPath, log }
}

function isSystemdNotLoaded(result: ExecResult): boolean {
  if (result.code === 0) return true
  const text = `${result.stderr} ${result.stdout}`.toLowerCase()
  return (
    text.includes("not loaded") ||
    text.includes("does not exist") ||
    text.includes("not found") ||
    text.includes("no such") ||
    text.includes("not active")
  )
}

async function isSystemdActive(unitName: string, host: ServiceHost): Promise<boolean> {
  const result = await host.run(["systemctl", "--user", "is-active", unitName])
  return result.code === 0 && result.stdout.trim() === "active"
}

/** Installs, reloads, and enables the systemd user service on Linux. */
export async function installSystemdService(
  spec: ServiceSpec,
  host: ServiceHost,
): Promise<{ file: string; log: string }> {
  checkServiceSpecControlChars(spec)
  const { unitName, unitDir, unitPath, log } = systemdPaths(spec.id, spec.label, host)

  const wasActive = await isSystemdActive(unitName, host)

  const content = buildSystemdUnit(spec)
  await mkdir(unitDir, { recursive: true, mode: 0o755 })
  await writeFile(unitPath, content, { encoding: "utf8", mode: 0o644 })
  await chmod(unitPath, 0o644)

  const reloadResult = await host.run(["systemctl", "--user", "daemon-reload"])
  if (reloadResult.code !== 0) {
    throw mapProgramError("systemctl", reloadResult)
  }

  const enableResult = await host.run(["systemctl", "--user", "enable", "--now", unitName])
  if (enableResult.code !== 0) {
    throw mapProgramError("systemctl", enableResult)
  }

  if (wasActive) {
    const restartResult = await host.run(["systemctl", "--user", "restart", unitName])
    if (restartResult.code !== 0) {
      throw mapProgramError("systemctl", restartResult)
    }
  }

  return { file: unitPath, log }
}

/** Disables and deletes the systemd user service on Linux. */
export async function uninstallSystemdService(id: string, label: string, host: ServiceHost): Promise<void> {
  const { unitName, unitPath } = systemdPaths(id, label, host)

  const disableResult = await host.run(["systemctl", "--user", "disable", "--now", unitName])
  if (!isSystemdNotLoaded(disableResult)) {
    throw mapProgramError("systemctl", disableResult)
  }

  try {
    await unlink(unitPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }

  const reloadResult = await host.run(["systemctl", "--user", "daemon-reload"])
  if (reloadResult.code !== 0) {
    throw mapProgramError("systemctl", reloadResult)
  }
}

/** Checks the systemd user service status on Linux. */
export async function systemdServiceStatus(id: string, label: string, host: ServiceHost): Promise<ServiceStatus> {
  const { unitName, unitPath, log } = systemdPaths(id, label, host)

  const isInstalled = await stat(unitPath)
    .then((s) => s.isFile())
    .catch(() => false)

  if (!isInstalled) {
    return { installed: false, running: false, file: unitPath, log }
  }

  const showResult = await host.run([
    "systemctl",
    "--user",
    "show",
    unitName,
    "-p",
    "ActiveState",
    "-p",
    "MainPID",
    "-p",
    "ExecMainStatus",
  ])
  if (showResult.code !== 0) {
    throw mapProgramError("systemctl", showResult)
  }

  let activeState = ""
  let pid: number | undefined
  let lastExit: number | undefined

  for (const line of showResult.stdout.split("\n")) {
    const equalIdx = line.indexOf("=")
    if (equalIdx === -1) continue
    const key = line.slice(0, equalIdx).trim()
    const value = line.slice(equalIdx + 1).trim()
    if (key === "ActiveState") {
      activeState = value
    } else if (key === "MainPID") {
      const parsed = parseInt(value, 10)
      if (Number.isInteger(parsed) && parsed > 0) pid = parsed
    } else if (key === "ExecMainStatus") {
      const parsed = parseInt(value, 10)
      if (Number.isInteger(parsed)) lastExit = parsed
    }
  }

  const running = activeState === "active"
  return { installed: true, running, pid, lastExit, file: unitPath, log }
}
