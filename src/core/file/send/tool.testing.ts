import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { ToolError } from "../../errors"
import { CHAT, HELD_MIRROR, SENT_ID } from "../../message/send.testing"
import { createSandbox, type Sandbox } from "../../outgoing/outgoing.testing"
import { invoke } from "../../tool"
import { serviceOperations } from "../../whatsapp/operations"
import type { ServiceOperations } from "../../whatsapp/service-socket"
import {
  DOCTOR_OK,
  HANGING_SYNC,
  eventually,
  startService,
  syncFixture,
  type SyncFixture,
} from "../../whatsapp/sync.testing"
import { resetWacliCache } from "../../whatsapp/wacli"
import { envelope, type FakeCall, type FakeMirror, type FakeResponse } from "../../whatsapp/wacli.testing"
import type { FileSendTiming } from "./deliver"
import type { FileSendOutput } from "./schema"
import { createFileSend } from "./tool"

export { CHAT, HELD_MIRROR, REPLY_ID, SENT_ID } from "../../message/send.testing"

/** The first bytes of a JPEG, which the tool takes for a photo. */
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])

/** The first bytes of an MP3 file, which the tool takes for audio. */
export const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])

/** What wacli answers for one file: its message id, and what it says of the mirror. */
export function sentResponse(id: string, extra: Record<string, unknown> = {}): Omit<FakeResponse, "args"> {
  return { stdout: envelope({ sent: true, to: CHAT, id, ...extra }) }
}

/** What a test sets up: the mirror, and the answers to `send file`, by the name the file is sent under. */
export type FileSendSetup = {
  mirror?: FakeMirror
  /** What wacli answers for each file name; a file not named here is accepted with `SENT_ID`. */
  files?: Record<string, Omit<FakeResponse, "args">>
}

/** One tool call's surroundings: a label `main` with a fake wacli on `PATH`, a working directory, the service and the tool. */
export type FileSendTest = {
  fixture: SyncFixture
  /** The working directory the tool runs in, and a place for other directories. */
  box: Sandbox
  /** Sets what the fake answers, without starting the service. */
  setUp(setup?: FileSendSetup): void
  /** Starts the sync service, with the operations of the CLI unless `operations` replaces them, and sets up the fake. */
  serve(setup?: FileSendSetup & { operations?: ServiceOperations; timing?: Partial<FileSendTiming> }): Promise<void>
  /** Runs the tool in the working directory and returns its result. */
  run(args: unknown, ctx?: { sendDirs?: string[] }): Promise<FileSendOutput>
  /** Runs the tool and returns the error it throws; `signal` cancels the call. */
  failure(args: unknown, signal?: AbortSignal): Promise<ToolError>
  /** The fake's calls of `send file`. */
  sendCalls(): Promise<FakeCall[]>
  /** The names the fake was asked to send, in order. */
  sentNames(): Promise<string[]>
  /** Waits until the fake has got `count` calls of `send file`. */
  sentOnce(count?: number): Promise<void>
  /** Every call the fake got besides the service's own (the version, `doctor` and `sync`). */
  wacliCalls(): Promise<FakeCall[]>
  /** What the label's outbox holds: nothing once a call has ended. */
  outboxEntries(): string[]
  close(): Promise<void>
}

const SERVICE_OWN = ["version", "doctor", "sync"]

/** The value of `flag` in a call of the fake. */
export function flagOf(call: FakeCall, flag: string): string | undefined {
  const at = call.argv.indexOf(flag)
  return at === -1 ? undefined : call.argv[at + 1]
}

/** Sets up a file send test; call `close` afterwards. */
export async function createFileSendTest(): Promise<FileSendTest> {
  resetWacliCache()
  const fixture = await syncFixture()
  const box = createSandbox()
  mkdirSync(fixture.paths.dir, { recursive: true })
  const originalPath = process.env.PATH
  process.env.PATH = fixture.fake.env.PATH
  let service: Awaited<ReturnType<typeof startService>> | undefined
  let tool = createFileSend()

  const setUp: FileSendTest["setUp"] = ({ mirror = HELD_MIRROR, files = {} } = {}) => {
    fixture.fake.setMirror(mirror)
    fixture.fake.setResponses([
      DOCTOR_OK,
      HANGING_SYNC,
      ...Object.entries(files).map(([name, response]) => ({ args: ["--filename", name], ...response })),
      { args: ["send", "file"], ...sentResponse(SENT_ID) },
    ])
  }
  const sendCalls: FileSendTest["sendCalls"] = async () =>
    (await fixture.fake.calls()).filter((call) => call.argv.includes("send"))
  const call = (args: unknown, signal?: AbortSignal, sendDirs?: string[]) =>
    invoke(tool, args, { cwd: box.root, stateDir: fixture.stateDir, sendDirs, signal })
  return {
    fixture,
    box,
    setUp,
    async serve({ operations = serviceOperations(), timing, ...setup } = {}) {
      tool = createFileSend(timing)
      service = await startService(fixture, operations)
      setUp(setup)
    },
    run: (args, ctx) => call(args, undefined, ctx?.sendDirs),
    async failure(args, signal) {
      try {
        await call(args, signal)
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("expected the call to fail")
    },
    sendCalls,
    async sentNames() {
      return (await sendCalls()).map((sent) => flagOf(sent, "--filename")!)
    },
    sentOnce: (count = 1) => eventually(async () => (await sendCalls()).length >= count),
    async wacliCalls() {
      return (await fixture.fake.calls()).filter((fake) => !SERVICE_OWN.some((name) => fake.argv.includes(name)))
    },
    outboxEntries: () => (existsSync(fixture.paths.outbox) ? readdirSync(fixture.paths.outbox) : []),
    async close() {
      service?.stop()
      await service?.outcome
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      resetWacliCache()
      box.remove()
      await fixture.cleanup()
    },
  }
}
