import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import type { LabelPaths } from "./labels"

/** Owner read and write only, like the rest of the label's state. */
const LOCK_MODE = 0o600

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST"
}

/** The process id in a lock file, or undefined when there is no file or it holds no process id. */
function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8").trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Whether a process with this id exists (also when it belongs to someone else). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Takes the exclusive lock of a label's sync service: a file holding this
 * process's id, created only if it does not exist. A lock whose process is
 * gone (or whose content is unreadable) is taken over.
 *
 * Returns the function that releases the lock, or undefined when another
 * live process holds it.
 */
export function acquireServiceLock(path: string): (() => void) | undefined {
  // Two tries: the second follows the removal of a lock nobody holds, and loses only to a run that took it first.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", LOCK_MODE)
      try {
        writeSync(fd, `${process.pid}\n`)
      } catch (error) {
        rmSync(path, { force: true })
        throw error
      } finally {
        closeSync(fd)
      }
      return () => {
        if (readPid(path) === process.pid) rmSync(path, { force: true })
      }
    } catch (error) {
      if (!isEexist(error)) throw error
    }
    const holder = readPid(path)
    if (holder !== undefined && holder !== process.pid && isAlive(holder)) return undefined
    rmSync(path, { force: true })
  }
  return undefined
}

/** The process id of the sync service running for the label, or undefined when its lock is missing, unreadable or stale. */
export function readServicePid(paths: LabelPaths): number | undefined {
  const pid = readPid(paths.serviceLock)
  return pid !== undefined && isAlive(pid) ? pid : undefined
}

/** Whether a sync service is running for the label. */
export function isServiceRunning(paths: LabelPaths): boolean {
  return readServicePid(paths) !== undefined
}
