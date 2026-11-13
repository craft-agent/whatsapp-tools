import { mkdirSync } from "node:fs"
import { ToolError } from "../../errors"
import { invoke, type ToolContext, type ToolSpec } from "../../tool"
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
import { ALICE, BOB, TEAM, wacliChat } from "../read.testing"

/** The subcommands of `wacli chats` that change a chat's state. */
const WRITE_ACTIONS = ["archive", "unarchive", "pin", "unpin", "mute", "unmute", "mark-read", "mark-unread"] as const

/** The mirror a test starts with: a person who has a name, one who has none, and a group, none pinned. */
export const HELD_MIRROR: FakeMirror = {
  chats: [
    wacliChat({ jid: ALICE, name: "Alice" }),
    wacliChat({ jid: BOB }),
    wacliChat({ jid: TEAM, kind: "group", name: "Team" }),
  ],
}

/** What wacli prints for a change it made. */
export const CHANGED: Omit<FakeResponse, "args"> = {
  stdout: envelope({ ok: true, action: "pin", chat: ALICE }),
}

/** What a test sets up: the mirror, and the answer to every `chats` command that changes a state. */
export type StateSetup = { mirror?: FakeMirror; change?: Omit<FakeResponse, "args"> }

/** One tool call's surroundings: a label `main` with a fake wacli on `PATH`, the sync service and the tools. */
export type StateTest = {
  fixture: SyncFixture
  /** Sets what the fake answers: the `mirror` (three unpinned chats by default) and the `change`. */
  setUp(setup?: StateSetup): void
  /** Sets the `exclude_chats` setting the tools run with from now on. */
  exclude(...chats: string[]): void
  /** Starts the sync service, with the operations of the CLI unless `operations` replaces them, and sets up the fake. */
  serve(setup?: StateSetup & { operations?: ServiceOperations }): Promise<void>
  /** Runs `tool` and returns its result. */
  run(tool: ToolSpec<any, any>, args: unknown): Promise<Record<string, any>>
  /** Runs `tool` and returns the error it throws; `signal` cancels the call. */
  failure(tool: ToolSpec<any, any>, args: unknown, signal?: AbortSignal): Promise<ToolError>
  /** The fake's calls of `chats` that change a state. */
  changeCalls(): Promise<FakeCall[]>
  /** Waits until the fake has got a call that changes a state. */
  changedOnce(): Promise<void>
  /** Every call the fake got besides the service's own (the version, `doctor` and `sync`). */
  wacliCalls(): Promise<FakeCall[]>
  close(): Promise<void>
}

const SERVICE_OWN = ["version", "doctor", "sync"]

/** The arguments of a call after `chats`: the subcommand and its flags. */
export function chatsArgv(call: FakeCall): string[] {
  return call.argv.slice(call.argv.indexOf("chats"))
}

/** Sets up a chat state test; call `close` afterwards. */
export async function createStateTest(): Promise<StateTest> {
  resetWacliCache()
  const fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  const originalPath = process.env.PATH
  process.env.PATH = fixture.fake.env.PATH
  let service: Awaited<ReturnType<typeof startService>> | undefined

  const setUp: StateTest["setUp"] = ({ mirror = HELD_MIRROR, change = CHANGED } = {}) => {
    fixture.fake.setMirror(mirror)
    fixture.fake.setResponses([
      DOCTOR_OK,
      HANGING_SYNC,
      ...WRITE_ACTIONS.map((action) => ({ args: ["chats", action], ...change })),
    ])
  }
  const changeCalls: StateTest["changeCalls"] = async () =>
    (await fixture.fake.calls()).filter((call) => WRITE_ACTIONS.some((action) => chatsArgv(call)[1] === action))
  let options: ToolContext["options"]
  const call = (tool: ToolSpec<any, any>, args: unknown, signal?: AbortSignal) =>
    invoke(tool, args, { cwd: fixture.stateDir, stateDir: fixture.stateDir, signal, options })
  return {
    fixture,
    setUp,
    exclude(...chats) {
      options = { exclude_chats: chats }
    },
    async serve({ operations = serviceOperations(), ...setup } = {}) {
      service = await startService(fixture, operations)
      setUp(setup)
    },
    run: (tool, args) => call(tool, args),
    async failure(tool, args, signal) {
      try {
        await call(tool, args, signal)
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("expected the call to fail")
    },
    changeCalls,
    changedOnce: () => eventually(async () => (await changeCalls()).length > 0),
    async wacliCalls() {
      return (await fixture.fake.calls()).filter((call) => !SERVICE_OWN.some((name) => call.argv.includes(name)))
    },
    async close() {
      service?.stop()
      await service?.outcome
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      resetWacliCache()
      await fixture.cleanup()
    },
  }
}
