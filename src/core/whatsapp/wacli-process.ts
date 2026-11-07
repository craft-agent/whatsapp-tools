import { spawn } from "node:child_process"
import { ToolError } from "../errors"
import { maskNumbers } from "./mask"

/** How long a stopped process may take to exit after SIGTERM before it is sent SIGKILL. */
const DEFAULT_STOP_GRACE_MS = 15_000

/** How long output may still arrive after the process exited, for a grandchild that keeps the pipes open. */
const DRAIN_MS = 100

/** How a wacli process ended: its exit code, or the signal that ended it. */
export type WacliExit = { code: number | null; signal: string | null }

export type WacliSpawnOptions = {
  /** The process's whole environment; build it with `wacliEnv`. */
  env: Record<string, string>
  /** Receives each line of standard output, without its line break. */
  onStdoutLine?(line: string): void
  /** Receives each line of standard error, without its line break, with phone numbers masked. */
  onStderrLine?(line: string): void
  /** How long `stop` waits after SIGTERM before it sends SIGKILL; 15 seconds by default. */
  stopGraceMs?: number
}

/** A running wacli process. */
export type WacliProcess = {
  pid: number | undefined
  /** Settles once the process ended and its output was delivered; rejects when the program could not be started. */
  exited: Promise<WacliExit>
  /** Sends SIGTERM, then SIGKILL after the grace period, and resolves once the process is gone. Safe to call again. */
  stop(): Promise<void>
}

/** Splits text into lines on `\n` (dropping a `\r` before it) across chunks, and hands each one over; `flush` hands over the partial last one. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let pending = ""
  const emit = (line: string) => {
    try {
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line)
    } catch {
      // A callback's failure must not break the handling of the process.
    }
  }
  return {
    push(chunk) {
      const lines = (pending + chunk).split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) emit(line)
    },
    flush() {
      if (pending === "") return
      const line = pending
      pending = ""
      emit(line)
    },
  }
}

function spawnError(error: NodeJS.ErrnoException): ToolError {
  return new ToolError("upstream_error", `wacli could not be started (${error.code ?? "error"}).`, { cause: error })
}

/**
 * Starts wacli without a shell and without standard input, and hands its
 * output over line by line. The caller owns the process: it ends only by
 * itself or through `stop`.
 */
export function spawnWacli(
  program: string,
  args: string[],
  { env, onStdoutLine, onStderrLine, stopGraceMs = DEFAULT_STOP_GRACE_MS }: WacliSpawnOptions,
): WacliProcess {
  const child = spawn(program, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] })

  const stdout = lineSplitter((line) => onStdoutLine?.(line))
  const stderr = lineSplitter((line) => onStderrLine?.(maskNumbers(line)))
  child.stdout.setEncoding("utf8").on("data", stdout.push)
  child.stderr.setEncoding("utf8").on("data", stderr.push)

  let killTimer: ReturnType<typeof setTimeout> | undefined
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  let ended: WacliExit | undefined

  const exited = new Promise<WacliExit>((resolve, reject) => {
    const finish = () => {
      clearTimeout(drainTimer)
      child.stdout.destroy()
      child.stderr.destroy()
      stdout.flush()
      stderr.flush()
      resolve(ended!)
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(killTimer)
      reject(spawnError(error))
    })
    child.on("exit", (code, signal) => {
      clearTimeout(killTimer)
      ended = { code, signal }
      drainTimer = setTimeout(finish, DRAIN_MS)
    })
    child.on("close", (code, signal) => {
      ended ??= { code, signal }
      finish()
    })
  })
  // `stop` and the caller may never look at a start that failed; the rejection still reaches whoever awaits `exited`.
  exited.catch(() => {})

  const stop = async (): Promise<void> => {
    if (ended === undefined && child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      child.kill("SIGTERM")
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), stopGraceMs)
    }
    await exited.catch(() => {})
  }

  return { pid: child.pid, exited, stop }
}
