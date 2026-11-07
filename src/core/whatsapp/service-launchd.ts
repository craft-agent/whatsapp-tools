import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ExecResult } from "../exec"
import {
  checkServiceSpecControlChars,
  mapProgramError,
  type ServiceHost,
  type ServiceSpec,
  type ServiceStatus,
} from "./service-types"

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
export function buildLaunchdPlist(spec: ServiceSpec, logPath: string): string {
  checkServiceSpecControlChars(spec)
  const agentLabel = `${spec.id}.${spec.label}`
  const allArgs = [spec.program, ...spec.args]
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

/** Installs and loads the launchd agent on macOS. */
export async function installLaunchdService(
  spec: ServiceSpec,
  host: ServiceHost,
): Promise<{ file: string; log: string }> {
  checkServiceSpecControlChars(spec)
  const { agentLabel, plistPath, logDir, logPath } = launchdPaths(spec.id, spec.label, host.home)

  await mkdir(logDir, { recursive: true, mode: 0o700 })
  await chmod(logDir, 0o700)

  const plistContent = buildLaunchdPlist(spec, logPath)
  await mkdir(dirname(plistPath), { recursive: true, mode: 0o755 })
  await writeFile(plistPath, plistContent, { encoding: "utf8", mode: 0o644 })
  await chmod(plistPath, 0o644)

  const bootoutResult = await host.run(["launchctl", "bootout", `gui/${host.uid}/${agentLabel}`])
  if (!isLaunchdNotLoaded(bootoutResult)) {
    throw mapProgramError("launchctl", bootoutResult)
  }

  const bootstrapResult = await host.run(["launchctl", "bootstrap", `gui/${host.uid}`, plistPath])
  if (bootstrapResult.code !== 0) {
    throw mapProgramError("launchctl", bootstrapResult)
  }

  return { file: plistPath, log: logPath }
}

/** Unloads and deletes the launchd agent on macOS. */
export async function uninstallLaunchdService(id: string, label: string, host: ServiceHost): Promise<void> {
  const { agentLabel, plistPath } = launchdPaths(id, label, host.home)

  const bootoutResult = await host.run(["launchctl", "bootout", `gui/${host.uid}/${agentLabel}`])
  if (!isLaunchdNotLoaded(bootoutResult)) {
    throw mapProgramError("launchctl", bootoutResult)
  }

  try {
    await unlink(plistPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
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
