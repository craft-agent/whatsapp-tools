import { randomUUID } from "node:crypto"
import { ToolError, isAbortError } from "../errors"
import { exec, type ExecResult } from "../exec"
import { mapProgramError } from "../whatsapp/service-types"

/** The attribute macOS reads to check a file before it is opened as an app. */
export const QUARANTINE_ATTRIBUTE = "com.apple.quarantine"

/** The program that sets it. */
export const XATTR = "/usr/bin/xattr"

/** What `xattr` is given to find itself: the system folders only. */
const XATTR_PATH = "/usr/bin:/bin"

/** How long `xattr` may take. */
const XATTR_TIMEOUT_MS = 30_000

/** The flag word of a quarantine mark that macOS itself writes for a download. */
const QUARANTINE_FLAGS = "0081"

/** What a quarantine step needs of the machine; a test supplies its own. */
export type QuarantineHost = {
  platform: NodeJS.Platform
  /** Runs a program through the one runner; resolves to its result, rejects when it cannot be started. */
  run(argv: string[], signal?: AbortSignal): Promise<ExecResult>
  /** The time in milliseconds. */
  now(): number
  /** A new version-4 UUID, in capitals. */
  uuid(): string
}

/** The machine this process runs on. */
export const SYSTEM_HOST: QuarantineHost = {
  platform: process.platform,
  run: (argv, signal) => exec(argv, { env: { PATH: XATTR_PATH }, timeoutMs: XATTR_TIMEOUT_MS, signal }),
  now: () => Date.now(),
  uuid: () => randomUUID().toUpperCase(),
}

/** What to mark: a file, or a folder with everything in it. */
export type Quarantined = { path: string; tree: boolean }

/** The attribute's value: `0081;<seconds in hexadecimal>;<program that saved it>;<UUID>`. */
export function quarantineValue(host: QuarantineHost, agent: string | undefined): string {
  const seconds = Math.floor(host.now() / 1000).toString(16)
  const name = (agent ?? "").replaceAll(";", "_")
  return `${QUARANTINE_FLAGS};${seconds};${name};${host.uuid()}`
}

/** The failure of `xattr` as a tool error, whether it ran and failed or could not be started. */
async function runXattr(host: QuarantineHost, argv: string[], signal?: AbortSignal): Promise<void> {
  let result: ExecResult
  try {
    result = await host.run(argv, signal)
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ToolError("upstream_error", "xattr could not be run.", { cause: error })
  }
  if (result.code !== 0) throw mapProgramError("xattr", result)
}

/**
 * Marks files, and the trees unpacking made, with the quarantine attribute,
 * so macOS checks them before anything opens them as an app. Elsewhere it
 * does nothing. Every path is tried even when one fails; the failure then
 * says how many did not take it, with the first one's reason.
 */
export async function quarantine(
  host: QuarantineHost,
  agent: string | undefined,
  items: readonly Quarantined[],
  signal?: AbortSignal,
): Promise<void> {
  if (host.platform !== "darwin") return
  const failures: ToolError[] = []
  for (const { path, tree } of items) {
    const argv = [XATTR, "-w", ...(tree ? ["-r"] : []), QUARANTINE_ATTRIBUTE, quarantineValue(host, agent), path]
    try {
      await runXattr(host, argv, signal)
    } catch (error) {
      if (!(error instanceof ToolError)) throw error
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    const first = failures[0]!.message
    const count = failures.length === 1 ? "" : ` (${failures.length} of ${items.length} paths)`
    throw new ToolError("upstream_error", `Not marked as downloaded${count}: ${first}`)
  }
}
