import { Buffer } from "node:buffer"
import { chmod, lstat, mkdir, readdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { ToolError } from "../errors"

/** The default label used when pairing a device without a name. */
export const DEFAULT_LABEL = "default"

/** 1 to 24 lowercase letters, digits and `_`, starting and ending with a letter or digit. */
export const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9_]{0,22}[a-z0-9])?$/

/** Maximum socket path length in bytes on UNIX domain sockets (103 bytes in UTF-8). */
const MAX_SOCKET_PATH_BYTES = 103

/** Maximum character length of a bad label shown in error messages. */
const MAX_BAD_LABEL_PREVIEW = 40

function quoteBadLabel(value: string): string {
  const truncated = value.length > MAX_BAD_LABEL_PREVIEW ? `${value.slice(0, MAX_BAD_LABEL_PREVIEW)}…` : value
  return JSON.stringify(truncated)
}

/** Whether `text` is a valid label name. */
export function isLabel(text: string): boolean {
  return typeof text === "string" && LABEL_PATTERN.test(text)
}

/** Returns the label, or throws `invalid_argument` stating the rule. */
export function checkLabel(label: string): string {
  if (!isLabel(label)) {
    throw new ToolError(
      "invalid_argument",
      `Invalid label ${quoteBadLabel(label)}: a label must be 1 to 24 lowercase letters, digits and "_", starting and ending with a letter or digit.`,
    )
  }
  return label
}

/** Where one label keeps its state; every path is inside `dir`. */
export type LabelPaths = {
  label: string
  /** `<stateDir>/<label>` */
  dir: string
  /** `<dir>/wacli` — wacli's store directory, passed with `--store` (session keys, mirror, media, its LOCK and its `.send.sock`). */
  store: string
  /** `<dir>/wacli/.send.sock` — the socket wacli's running sync serves (wacli creates it; listed only so its length is checked). */
  wacliSocket: string
  /** `<dir>/service.sock` — the sync service's own socket. */
  socket: string
  /** `<dir>/outbox` — short-lived copies of files being sent; WACLI_MEDIA_ROOTS. */
  outbox: string
  /** `<dir>/service.lock` — the process id of the sync service running for the label. */
  serviceLock: string
  /** `<dir>/service.json` — the state the sync service last recorded. */
  serviceStatus: string
}

/**
 * Resolves the state paths for `label`.
 *
 * Checks the label and verifies that `stateDir` is absolute (throws `internal_error` otherwise).
 * Throws `invalid_argument` when a socket path exceeds 103 bytes in UTF-8.
 */
export function labelPaths(stateDir: string, label: string): LabelPaths {
  if (!isAbsolute(stateDir)) {
    throw new ToolError("internal_error", `State directory must be absolute; got ${JSON.stringify(stateDir)}.`)
  }
  checkLabel(label)
  const dir = join(stateDir, label)
  const store = join(dir, "wacli")
  const paths: LabelPaths = {
    label,
    dir,
    store,
    wacliSocket: join(store, ".send.sock"),
    socket: join(dir, "service.sock"),
    outbox: join(dir, "outbox"),
    serviceLock: join(dir, "service.lock"),
    serviceStatus: join(dir, "service.json"),
  }
  for (const socketPath of [paths.wacliSocket, paths.socket]) {
    const socketBytes = Buffer.byteLength(socketPath, "utf8")
    if (socketBytes > MAX_SOCKET_PATH_BYTES) {
      throw new ToolError(
        "invalid_argument",
        `Socket path "${socketPath}" is ${socketBytes} bytes (longer than the 103-byte limit for UNIX sockets); choose a shorter state directory.`,
      )
    }
  }
  return paths
}

/**
 * The labels that have a state directory, sorted.
 *
 * A missing `stateDir` gives `[]`. Entries that are not real directories
 * (such as symlinks) or whose names are not valid labels are skipped.
 */
export async function listLabels(stateDir: string): Promise<string[]> {
  let entries: string[]
  try {
    const dirEntries = await readdir(stateDir, { withFileTypes: true })
    entries = dirEntries.filter((e) => isLabel(e.name)).map((e) => e.name)
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return []
    }
    throw err
  }

  const valid: string[] = []
  for (const name of entries) {
    try {
      const stat = await lstat(join(stateDir, name))
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        valid.push(name)
      }
    } catch {
      // Entry may have been removed concurrently; skip it.
    }
  }
  return valid.sort()
}

/**
 * Picks the label a call works on, from its `account` argument:
 * - given: checked, and it must be among listLabels, else not_found naming the label and listing the known ones (or saying none is paired);
 * - absent with exactly one label: that one;
 * - absent with none: not_found, "No WhatsApp account is paired yet; pair a device first.";
 * - absent with several: invalid_argument, "Several WhatsApp accounts are paired; name one with `account`: a, b."
 */
export async function pickLabel(stateDir: string, account: string | undefined): Promise<LabelPaths> {
  const labels = await listLabels(stateDir)

  if (account !== undefined) {
    const label = checkLabel(account)
    if (!labels.includes(label)) {
      const known = labels.length > 0 ? `known accounts: ${labels.join(", ")}.` : "no WhatsApp account is paired yet."
      throw new ToolError("not_found", `WhatsApp account "${label}" was not found; ${known}`)
    }
    return labelPaths(stateDir, label)
  }

  if (labels.length === 0) {
    throw new ToolError("not_found", "No WhatsApp account is paired yet; pair a device first.")
  }

  if (labels.length > 1) {
    throw new ToolError(
      "invalid_argument",
      `Several WhatsApp accounts are paired; name one with \`account\`: ${labels.join(", ")}.`,
    )
  }

  return labelPaths(stateDir, labels[0]!)
}

/**
 * Creates `stateDir` and the label's directory with mode 0700 (chmod both to 0700 even if they existed,
 * since mkdir's mode is masked by umask), refusing (invalid_argument) when the label path exists and
 * is not a real directory (e.g. a symlink). Returns the paths.
 */
export async function ensureLabelDir(stateDir: string, label: string): Promise<LabelPaths> {
  const paths = labelPaths(stateDir, label)

  const stateStat = await lstat(stateDir).catch(() => undefined)
  if (stateStat && !stateStat.isDirectory()) {
    throw new ToolError("invalid_argument", `State directory "${stateDir}" exists and is not a directory.`)
  }

  const dirStat = await lstat(paths.dir).catch(() => undefined)
  if (dirStat && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" exists and is not a directory.`)
  }

  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  await chmod(stateDir, 0o700)
  await chmod(paths.dir, 0o700)

  return paths
}
