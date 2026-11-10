import { chmod, lstat, mkdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import {
  checkLauncherName,
  checkServiceSpecControlChars,
  mapProgramError,
  type ServiceHost,
  type ServiceName,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-types"

/** Hands over to the program and arguments after it, so the agent is listed under the script's own name. */
export const LAUNCHER_SCRIPT = '#!/bin/sh\nexec "$@"\n'

/** Escapes special XML characters in string values for plist generation. */
export function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

/** Builds the launchd property list XML content. */
export function buildLaunchdPlist(spec: ServiceSpec, logPath: string, launcherPath: string): string {
  checkServiceSpecControlChars(spec)
  checkLauncherName(spec.launcher)
  const agentLabel = `${spec.id}.${spec.label}`
  const allArgs = [launcherPath, spec.program, ...spec.args]
  const argsXml = allArgs.map((arg) => `\t\t<string>${xmlEscape(arg)}</string>`).join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(agentLabel)}</string>
\t<key>ProgramArguments</key>
\t<array>
${argsXml}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${xmlEscape(spec.path)}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>60</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`
}

function launchdPaths(id: string, label: string, home: string) {
  const agentLabel = `${id}.${label}`
  const plistPath = join(home, "Library", "LaunchAgents", `${agentLabel}.plist`)
  const logDir = join(home, "Library", "Logs", id)
  const logPath = join(logDir, `${label}.log`)
  return { agentLabel, plistPath, logDir, logPath }
}

function launcherPaths(id: string, label: string, launcher: string, home: string) {
  const launcherDir = join(home, "Library", "Application Support", id)
  const launcherPath = join(launcherDir, `${launcher}-${label}`)
  return { launcherDir, launcherPath }
}

function isLaunchdNotLoaded(result: ExecResult): boolean {
  if (result.code === 0) return true
  const text = `${result.stderr} ${result.stdout}`.toLowerCase()
  return (
    text.includes("not loaded") ||
    text.includes("no such process") ||
    text.includes("input/output error") ||
    text.includes("could not find") ||
    result.code === 3 ||
    result.code === 5
  )
}

/** How long to wait between checks that launchd has let go of the job. */
const STOP_POLL_INTERVAL_MS = 200

/**
 * How long to wait for the job to go. launchd kills a job 20 seconds after
 * asking it to stop (the default ExitTimeOut), so it is gone well within this.
 */
const STOP_TIMEOUT_MS = 30_000

/** Unloads the agent and returns once launchd no longer lists it. */
async function unloadLaunchdAgent(host: ServiceHost, agentLabel: string): Promise<void> {
  const target = `gui/${host.uid}/${agentLabel}`
  const bootoutResult = await host.run(["launchctl", "bootout", target])
  if (!isLaunchdNotLoaded(bootoutResult)) {
    throw mapProgramError("launchctl", bootoutResult)
  }

  // bootout returns before launchd has torn the job down, and loading it
  // again until then fails with an input/output error.
  const sleep = host.sleep ?? setTimeout
  const polls = Math.ceil(STOP_TIMEOUT_MS / STOP_POLL_INTERVAL_MS)
  for (let poll = 0; poll < polls; poll++) {
    const printResult = await host.run(["launchctl", "print", target])
    if (printResult.code !== 0) return
    await sleep(STOP_POLL_INTERVAL_MS)
  }
  throw new ToolError(
    "upstream_error",
    `The service did not stop within ${STOP_TIMEOUT_MS / 1000} seconds; run the command again.`,
  )
}

/** Installs and loads the launchd agent on macOS. */
export async function installLaunchdService(
  spec: ServiceSpec,
  host: ServiceHost,
): Promise<{ file: string; log: string }> {
  checkServiceSpecControlChars(spec)
  checkLauncherName(spec.launcher)
  const { agentLabel, plistPath, logDir, logPath } = launchdPaths(spec.id, spec.label, host.home)
  const { launcherDir, launcherPath } = launcherPaths(spec.id, spec.label, spec.launcher, host.home)

  await mkdir(logDir, { recursive: true, mode: 0o700 })
  await chmod(logDir, 0o700)

  await mkdir(launcherDir, { recursive: true, mode: 0o700 })
  await chmod(launcherDir, 0o700)
  // Renamed into place, so a running agent never finds the launcher missing,
  // and a link at its path is replaced rather than followed.
  const staging = join(launcherDir, `.${basename(launcherPath)}.tmp`)
  try {
    await unlink(staging)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
  await writeFile(staging, LAUNCHER_SCRIPT, { encoding: "utf8", mode: 0o755, flag: "wx" })
  await chmod(staging, 0o755)
  await rename(staging, launcherPath)

  const plistContent = buildLaunchdPlist(spec, logPath, launcherPath)
  await mkdir(dirname(plistPath), { recursive: true, mode: 0o755 })
  await writeFile(plistPath, plistContent, { encoding: "utf8", mode: 0o644 })
  await chmod(plistPath, 0o644)

  await unloadLaunchdAgent(host, agentLabel)

  const bootstrapResult = await host.run(["launchctl", "bootstrap", `gui/${host.uid}`, plistPath])
  if (bootstrapResult.code !== 0) {
    throw mapProgramError("launchctl", bootstrapResult)
  }

  return { file: plistPath, log: logPath }
}

/**
 * Unloads and deletes the launchd agent on macOS, with its launcher script and
 * the launcher's directory once empty.
 */
export async function uninstallLaunchdService(name: ServiceName, label: string, host: ServiceHost): Promise<void> {
  const { agentLabel, plistPath } = launchdPaths(name.id, label, host.home)

  await unloadLaunchdAgent(host, agentLabel)

  try {
    await unlink(plistPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }

  // Checked only once the agent is gone: a caller that reads a refusal as
  // "no service here" must not leave a loaded agent behind.
  checkLauncherName(name.launcher)
  const { launcherDir, launcherPath } = launcherPaths(name.id, label, name.launcher, host.home)
  await removeFileThenEmptyDir(launcherPath, launcherDir)
}

/**
 * Deletes `path` when it is a regular file, never following a link, then `dir`
 * when nothing else is in it. Whatever cannot be tidied is left alone.
 */
async function removeFileThenEmptyDir(path: string, dir: string): Promise<void> {
  try {
    if ((await lstat(path)).isFile()) await unlink(path)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err
  }

  try {
    await rmdir(dir)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT" && code !== "ENOTDIR") throw err
  }
}

/** Checks the launchd agent status on macOS. */
export async function launchdServiceStatus(id: string, label: string, host: ServiceHost): Promise<ServiceStatus> {
  const { agentLabel, plistPath, logPath } = launchdPaths(id, label, host.home)

  const isInstalled = await stat(plistPath)
    .then((s) => s.isFile())
    .catch(() => false)

  if (!isInstalled) {
    return { installed: false, running: false, file: plistPath, log: logPath }
  }

  const printResult = await host.run(["launchctl", "print", `gui/${host.uid}/${agentLabel}`])
  if (printResult.code !== 0) {
    return { installed: true, running: false, file: plistPath, log: logPath }
  }

  const running = /state\s*=\s*running/i.test(printResult.stdout)
  const pidMatch = printResult.stdout.match(/\bpid\s*=\s*(\d+)/i)
  const pid = pidMatch ? parseInt(pidMatch[1]!, 10) : undefined
  const exitMatch = printResult.stdout.match(/\blast exit code\s*=\s*(-?\d+)/i)
  const lastExit = exitMatch ? parseInt(exitMatch[1]!, 10) : undefined

  return { installed: true, running, pid, lastExit, file: plistPath, log: logPath }
}
