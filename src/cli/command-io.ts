import { createInterface } from "node:readline/promises"
import type { ServiceHost } from "../core/whatsapp/service"
import type { EntryProfile } from "../entry/profile"

/** The exit codes of a command: it did its work, the work failed, or the command line was wrong. */
export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2

/** Default interactive line reader on standard input. */
export async function defaultReadLine(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

/** What a command of the command line needs from its surroundings; `main.ts` wires the process, a test supplies its own. */
export type CommandIo = {
  /** Where the `<envPrefix>_*` settings fall back to, and what wacli's environment is taken from. */
  env: Record<string, string | undefined>
  /** Receives what a command says to the person. */
  stdout(text: string): void
  /** Receives usage lines and errors. */
  stderr(text: string): void
  /** Stops a running command when it aborts. */
  signal?: AbortSignal
  /** The settings' environment prefix and the toolsets; defaults to this package's. */
  profile?: EntryProfile
  /** Whether standard input is an interactive terminal. */
  isTTY?: boolean
  /** Reads a line of input with an optional prompt; used for interactive confirmations. */
  readLine?(prompt: string): Promise<string | undefined>
  /** The node binary and the CLI script to put in the service; default `process.execPath` and the realpath of `process.argv[1]`. */
  self?: { program: string; script: string }
  /** Injectable service host for managing system services; defaults to the operating system host. */
  serviceHost?: ServiceHost
}
