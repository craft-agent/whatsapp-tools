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
  /** Answers, then waits until it is stopped; it exits 0 on SIGTERM unless `onTerm` or `ignoreTerm` says otherwise. */
  hang?: true
  /** Lines written to stderr, each `afterMs` (0 by default) after the response started, whether it hangs or exits. */
  stderrLines?: { line: string; afterMs?: number }[]
  /** Exits with `exit` this long after the response started, even when it hangs. */
  exitAfterMs?: number
  /** What it does on SIGTERM: writes `stderr` and exits with `exit`. */
  onTerm?: { exit: number; stderr?: string }
  /** Ignores SIGTERM, so only SIGKILL stops it. */
  ignoreTerm?: true
}

/**
 * The mirror the fake answers reads from, in wacli's own JSON shapes (`wacli.mirror.cjs` says which reads and how):
 * the chats `chats list` prints, the messages of `messages list` (listed in the order they arrived), the polls of
 * `polls list`, the call events of `calls list`, the contacts of `contacts search` and the answers of `contacts check`.
 */
export type FakeMirror = {
  chats?: Record<string, unknown>[]
  messages?: Record<string, unknown>[]
  polls?: Record<string, unknown>[]
  calls?: Record<string, unknown>[]
  /** The contacts `contacts search` looks through, as `{ jid, phone, name, alias, system_name, updated_at }`. */
  contacts?: Record<string, unknown>[]
  /**
   * What WhatsApp answers `contacts check` by the number's digits: whether it is registered, whether it answered for
   * the number at all (`responded`, true unless the entry says otherwise) and the JID of a registered one. A number
   * with no entry is left out of WhatsApp's answer.
   */
  check?: Record<string, { registered: boolean; responded?: boolean; jid?: string }>
  /** Makes `messages search` answer as wacli's full-text search: hits in this order of message ids, `fts: true`. */
  relevance?: string[]
}

/** One call of the fake wacli, as it recorded it. */
export type FakeCall = {
  /** Every argument the fake got, global flags included. */
  argv: string[]
  /** The `WACLI_*` variables it started with. */
  env: Record<string, string>
  cwd: string
  /** The fake's process id, for a test that stops a call that hangs. */
  pid: number
}

export type FakeWacli = {
  dir: string
  /** An environment whose `PATH` starts with the fake's directory, then `node`'s, then the current `PATH`. */
  env: Record<string, string>
  /** Changes what the fake answers from the next call on; `fallback` answers what no response matches. */
  setResponses(responses: FakeResponse[], fallback?: Omit<FakeResponse, "args">): void
  /** Changes the mirror the fake reads from, from the next call on; the responses stay, and win where they match. */
  setMirror(mirror: FakeMirror): void
  /** Every call so far, in order, the version checks included. */
  calls(): Promise<FakeCall[]>
  cleanup(): Promise<void>
}

const SCRIPT = fileURLToPath(new URL("./wacli.fake.cjs", import.meta.url))
const MIRROR_SCRIPT = fileURLToPath(new URL("./wacli.mirror.cjs", import.meta.url))

/** The stdout of a successful wacli call that returns `data`. */
export function envelope(data: unknown): string {
  return `${JSON.stringify({ success: true, data, error: null })}\n`
}

/** The stderr of a failed wacli call that says `text`. */
export function failure(text: string): string {
  return `${JSON.stringify({ success: false, data: null, error: text })}\n`
}

/** One event of `wacli sync --events` as the line it writes to stderr; its time is 13 digits, as wacli's are. */
export function eventLine(name: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ event: name, data, ts: 1730000000000 })
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
  await copyFile(MIRROR_SCRIPT, join(dir, "wacli.mirror.cjs"))
  const version = options.version ?? WACLI_MIN_VERSION
  let responses: FakeResponse[] = []
  let fallback: Omit<FakeResponse, "args"> | undefined
  let mirror: FakeMirror | undefined
  const write = () =>
    writeFileSync(join(dir, "fake.json"), JSON.stringify({ version, responses, default: fallback, mirror }))
  write()
  return {
    dir,
    env: { PATH: [dir, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter), HOME: dir },
    setResponses(next, nextFallback) {
      responses = next
      fallback = nextFallback
      write()
    },
    setMirror(next) {
      mirror = next
      write()
    },
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
