import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { callService } from "./service-client"
import type { ServiceOperation } from "./service-socket"
import {
  DOCTOR_OK,
  HANGING_SYNC,
  NEVER_CONNECTS,
  connectsAfter,
  eventually,
  startServiceWith,
  syncFixture,
  type SyncFixture,
} from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { eventLine } from "./wacli.testing"

let fixture: SyncFixture

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

const call = (op: string, options: { timeoutMs?: number } = {}) =>
  callService(fixture.paths, op, undefined, { mode: "write", ...options })

const connectedLogs = () => fixture.logs.filter((line) => line === "event connected").length

/** An operation that says what it saw when it ran. */
const look: ServiceOperation = {
  kind: "delegated",
  writes: true,
  run: async () => ({ connected: connectedLogs(), state: fixture.status()?.state }),
}

const failureOf = async (promise: Promise<unknown>) => (await promise.catch((caught: unknown) => caught)) as ToolError

describe("a delegated operation before the child is ready", () => {
  test("waits for the child to report connected, and the status stays starting until then", async () => {
    const { outcome, stop } = startServiceWith(fixture, connectsAfter(1000), { look })
    await eventually(async () => (await fixture.syncCalls()).length === 1)
    expect(fixture.status()?.state).toBe("starting")

    expect(await call("look")).toEqual({ connected: 1, state: "running" })
    stop()
    await outcome
  })

  test("is answered upstream_error, and not run, when the deadline passes before the child connects", async () => {
    const ran: string[] = []
    const { outcome, stop } = startServiceWith(fixture, NEVER_CONNECTS, {
      mark: { kind: "delegated", writes: true, run: async () => ran.push("mark") },
    })
    await eventually(async () => (await fixture.syncCalls()).length === 1)

    const error = await failureOf(call("mark", { timeoutMs: 300 }))
    expect(error).toBeInstanceOf(ToolError)
    expect([error.code, error.message]).toEqual([
      "upstream_error",
      "The sync service is not connected yet; nothing was sent.",
    ])
    expect(ran).toEqual([])
    expect(fixture.status()?.state).toBe("starting")
    stop()
    await outcome
  })

  test("is answered upstream_error, and not run, when the child ends first", async () => {
    const ran: string[] = []
    const { outcome } = startServiceWith(fixture, NEVER_CONNECTS, {
      mark: { kind: "delegated", writes: true, run: async () => ran.push("mark") },
    })
    await eventually(async () => (await fixture.syncCalls()).length === 1)
    const waiting = failureOf(call("mark"))
    const [child] = await fixture.syncCalls()
    process.kill(child!.pid, "SIGKILL")

    expect((await waiting).code).toBe("upstream_error")
    expect(ran).toEqual([])
    expect(await outcome).toMatchObject({ exitCode: 1, state: "failed" })
  })

  test("runs once the child is connected, also after it disconnected and while it reconnects", async () => {
    const lines = ["connected", "disconnected", "reconnecting"].map((name) => ({ line: eventLine(name) }))
    const { outcome, stop } = startServiceWith(fixture, { ...HANGING_SYNC, stderrLines: lines }, { look })
    await eventually(() => fixture.logs.includes("event reconnecting"))
    expect(await call("look")).toEqual({ connected: 1, state: "running" })
    stop()
    await outcome
  })
})

describe("readiness after an exclusive operation", () => {
  test("is reset by the restart: the next delegated operation waits for the new child to connect", async () => {
    const { outcome, stop } = startServiceWith(fixture, HANGING_SYNC, {
      look,
      swap: { kind: "exclusive", writes: true, run: async () => ({ swapped: true }) },
    })
    await eventually(() => connectedLogs() === 1)
    fixture.fake.setResponses([DOCTOR_OK, connectsAfter(800)])

    expect(await call("swap")).toEqual({ swapped: true, service_running: true })
    expect(fixture.status()?.state).toBe("starting")
    expect(await call("look")).toEqual({ connected: 2, state: "running" })
    stop()
    await outcome
  })

  test("needs no readiness: an exclusive operation runs while the child has not connected", async () => {
    const { outcome, stop } = startServiceWith(fixture, NEVER_CONNECTS, {
      swap: { kind: "exclusive", writes: true, run: async () => ({ swapped: true }) },
    })
    await eventually(async () => (await fixture.syncCalls()).length === 1)

    expect(await call("swap")).toEqual({ swapped: true, service_running: true })
    await eventually(async () => (await fixture.syncCalls()).length === 2)
    expect(fixture.status()?.state).toBe("starting")
    stop()
    await outcome
  })
})
