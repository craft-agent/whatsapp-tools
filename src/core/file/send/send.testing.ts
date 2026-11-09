import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Makes a FIFO at `path`; throws where the machine has no `mkfifo`. */
export function makeFifo(path: string): void {
  execFileSync("mkfifo", [path])
}

/** Whether this machine has `mkfifo` and lets a test make a FIFO. */
export function canMakeFifo(): boolean {
  const probe = join(tmpdir(), `fifo-probe-${process.pid}`)
  try {
    makeFifo(probe)
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { force: true })
  }
}
