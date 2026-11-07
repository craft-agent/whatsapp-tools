import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { labelPaths, type LabelPaths } from "./labels"
import type { ServiceOperations } from "./service-socket"
import { readServiceStatus, type ServiceStatus } from "./service-status"
import { runSync, type SyncOptions, type SyncOutcome } from "./sync"
import {
  envelope,
  eventLine,
  installFakeWacli,
  type FakeCall,
  type FakeResponse,
  type FakeWacli,
} from "./wacli.testing"

export const LABEL = "main"

/** How long a test waits for something the service does on its own. */
const EVENTUALLY_MS = 8_000

const POLL_INTERVAL_MS = 20

/** A socket path must fit in 103 bytes, so a long temp directory gives way to `/tmp`. */
const MAX_TEMP_DIR_LENGTH = 50

/** What `wacli doctor` answers for a paired label whose session is usable. */
export const DOCTOR_OK: FakeResponse = {
  args: ["doctor"],
  stdout: envelope({ authenticated: true, session_revoked: false, lock_held: false, connected: false, store: {} }),
}

/** A `doctor` answer for the given state of the session. */
export function doctor(state: { authenticated: boolean; session_revoked: boolean }): FakeResponse {
  return { args: ["doctor"], stdout: envelope({ ...state, lock_held: false, connected: false, store: {} }) }
}

/** A sync that connects and runs until it is stopped. */
export const HANGING_SYNC: FakeResponse = {
  args: ["sync"],
  hang: true,
  stderrLines: [{ line: eventLine("connected") }],
  onTerm: { exit: 0, stderr: `${eventLine("stopping")}\n` },
}

/** A `doctor` answer for a paired label whose store is locked by the wacli with this process id. */
export function doctorHeldBy(pid: number | undefined, lockHeld = true): FakeResponse {
  return {
    args: ["doctor"],
    stdout: envelope({
      authenticated: true,
      session_revoked: false,
      lock_held: lockHeld,
      ...(pid === undefined ? {} : { lock_owner_pid: pid }),
      connected: false,
      store: {},
    }),
  }
}

/** A short temporary directory, which keeps the socket paths of a label under the platform's limit. */
export async function shortTempDir(): Promise<string> {
  const base = tmpdir().length > MAX_TEMP_DIR_LENGTH ? "/tmp" : tmpdir()
  return mkdtemp(join(base, "wa-"))
}

/** Polls until `condition` holds, failing the test after `ms`. */
export async function eventually(condition: () => boolean | Promise<boolean>, ms = EVENTUALLY_MS): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/** Starts a process that does nothing until killed, standing in for another service that holds a lock. */
export async function startIdleProcess(): Promise<ChildProcess & { pid: number }> {
  const child = spawn("sleep", ["60"], { stdio: "ignore" })
  if (child.pid === undefined) throw new Error("could not start the idle process")
  child.unref()
  return child as ChildProcess & { pid: number }
}

/** A promise a test settles itself: awaiting `opened` waits for `open`. */
export function gate(): { opened: Promise<void>; open(): void } {
  let open = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

/** An operation's run that waits until `signal` aborts and then fails as an aborted operation does; `started` is told first. */
export function untilAborted(signal: AbortSignal, started?: () => void): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
    started?.()
  })
}

/** A sync test's surroundings: a state directory, a fake wacli, and what the service logged. */
export type SyncFixture = {
  fake: FakeWacli
  stateDir: string
  paths: LabelPaths
  /** Every line handed to `log`. */
  logs: string[]
  /** Runs the service on `LABEL` until it ends by itself. */
  run(overrides?: Partial<SyncOptions>): Promise<SyncOutcome>
  /** Starts a run that a test stops itself; `stop` aborts it. */
  start(overrides?: Partial<SyncOptions>): { outcome: Promise<SyncOutcome>; stop(): void }
  /** The status file as a reader sees it. */
  status(): ServiceStatus | null
  /** The fake's calls of the sync child, in order. */
  syncCalls(): Promise<FakeCall[]>
  /** The service's socket and lock files that are still there. */
  leftovers(): string[]
  cleanup(): Promise<void>
}

/** Starts the service with `operations` and a child that connects and hangs; resolves once the child is connected. */
export async function startService(fixture: SyncFixture, operations: ServiceOperations = {}) {
  const run = startServiceWith(fixture, HANGING_SYNC, operations)
  await eventually(() => fixture.logs.includes("event connected"))
  return run
}

/** Starts the service with `operations` and a child that answers as `sync` says, without waiting for anything. */
export function startServiceWith(
  fixture: SyncFixture,
  sync: FakeResponse,
  operations: ServiceOperations = {},
  overrides: Partial<SyncOptions> = {},
) {
  fixture.fake.setResponses([DOCTOR_OK, sync])
  return fixture.start({ operations, ...overrides })
}

/** A sync that reports `connected` only `afterMs` after it started, and then runs until it is stopped. */
export function connectsAfter(afterMs: number): FakeResponse {
  return { ...HANGING_SYNC, stderrLines: [{ line: eventLine("connected"), afterMs }] }
}

/** A sync that runs until it is stopped and never reports `connected`. */
export const NEVER_CONNECTS: FakeResponse = { args: ["sync"], hang: true, onTerm: { exit: 0 } }

/** Starts a process that ignores SIGTERM, standing in for a wacli that does not stop gracefully. */
export async function startStubbornProcess(): Promise<ChildProcess & { pid: number }> {
  const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')"
  const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] })
  if (child.pid === undefined) throw new Error("could not start the stubborn process")
  await new Promise((resolve) => child.stdout!.once("data", resolve))
  child.unref()
  return child as ChildProcess & { pid: number }
}

/** Sets up a sync test with no pause before a restart; call `cleanup` afterwards. */
export async function syncFixture(): Promise<SyncFixture> {
  const fake = await installFakeWacli()
  const stateDir = await shortTempDir()
  const paths = labelPaths(stateDir, LABEL)
  const logs: string[] = []

  const run: SyncFixture["run"] = (overrides = {}) =>
    runSync({
      stateDir,
      label: LABEL,
      env: fake.env,
      signal: new AbortController().signal,
      log: (line) => logs.push(line),
      restartDelayMs: 0,
      ...overrides,
    })

  return {
    fake,
    stateDir,
    paths,
    logs,
    run,
    start(overrides = {}) {
      const controller = new AbortController()
      return { outcome: run({ signal: controller.signal, ...overrides }), stop: () => controller.abort() }
    },
    status: () => readServiceStatus(paths),
    async syncCalls() {
      return (await fake.calls()).filter((call) => call.argv.includes("sync"))
    },
    leftovers: () => [paths.socket, paths.serviceLock].filter((path) => existsSync(path)),
    async cleanup() {
      await fake.cleanup()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}
