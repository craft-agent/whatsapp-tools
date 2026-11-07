import { writeFileSync } from "node:fs"
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { LabelPaths } from "./labels"
import { WACLI_MIN_VERSION } from "./wacli"

/** One canned answer of the fake wacli; `wacli.fake.cjs` says how it is matched. */
export type FakeResponse = {
  /** Arguments that must appear in order, as one run, among the call's arguments without the global flags. */
  args: string[]
  stdout?: string
  stderr?: string
  exit?: number
  /** Waits this long before answering. */
  sleepMs?: number
  /** Answers, then waits until it is stopped; it exits 0 on SIGTERM. */
  hang?: true
}

/** One call of the fake wacli, as it recorded it. */
export type FakeCall = {
  /** Every argument the fake got, global flags included. */
  argv: string[]
  /** The `WACLI_*` variables it started with. */
  env: Record<string, string>
  cwd: string
}

export type FakeWacli = {
  dir: string
  /** An environment whose `PATH` starts with the fake's directory, then `node`'s, then the current `PATH`. */
  env: Record<string, string>
  /** Changes what the fake answers from the next call on; `fallback` answers what no response matches. */
  setResponses(responses: FakeResponse[], fallback?: Omit<FakeResponse, "args">): void
  /** Every call so far, in order, the version checks included. */
  calls(): Promise<FakeCall[]>
  cleanup(): Promise<void>
}

const SCRIPT = fileURLToPath(new URL("./wacli.fake.cjs", import.meta.url))

/** The stdout of a successful wacli call that returns `data`. */
export function envelope(data: unknown): string {
  return `${JSON.stringify({ success: true, data, error: null })}\n`
}

/** The stderr of a failed wacli call that says `text`. */
export function failure(text: string): string {
  return `${JSON.stringify({ success: false, data: null, error: text })}\n`
}

/** A label's paths under `dir`, written out so a test does not depend on how `labels.ts` derives them. */
export function pathsIn(dir: string, label = "main"): LabelPaths {
  const labelDir = join(dir, label)
  return {
    label,
    dir: labelDir,
    store: join(labelDir, "wacli"),
    wacliSocket: join(labelDir, "wacli", ".send.sock"),
    socket: join(labelDir, "service.sock"),
    outbox: join(labelDir, "outbox"),
    serviceLock: join(labelDir, "service.lock"),
    serviceStatus: join(labelDir, "service.json"),
  }
}

/** Installs a fake `wacli` in a fresh temp directory; it answers `version` with `options.version` (0.26.0 by default). */
export async function installFakeWacli(options: { version?: string } = {}): Promise<FakeWacli> {
  const dir = await mkdtemp(join(tmpdir(), "wacli-fake-"))
  const program = join(dir, "wacli")
  await copyFile(SCRIPT, program)
  await chmod(program, 0o755)
  const version = options.version ?? WACLI_MIN_VERSION
  const setResponses: FakeWacli["setResponses"] = (responses, fallback) =>
    writeFileSync(join(dir, "fake.json"), JSON.stringify({ version, responses, default: fallback }))
  setResponses([])
  return {
    dir,
    env: { PATH: [dir, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter), HOME: dir },
    setResponses,
    async calls() {
      const text = await readFile(join(dir, "calls.jsonl"), "utf8").catch(() => "")
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as FakeCall)
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
