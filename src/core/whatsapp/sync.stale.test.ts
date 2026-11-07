import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { isAlive } from "./service-lock"
import { STORE_HELD_REASON } from "./sync-start"
import {
  HANGING_SYNC,
  doctorHeldBy,
  eventually,
  startIdleProcess,
  startStubbornProcess,
  syncFixture,
  type SyncFixture,
} from "./sync.testing"
import { resetWacliCache } from "./wacli"

let fixture: SyncFixture
const started: ChildProcess[] = []

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
})

afterEach(async () => {
  for (const child of started.splice(0)) child.kill("SIGKILL")
  await fixture.cleanup()
})

async function idle() {
  const child = await startIdleProcess()
  started.push(child)
  return child
}

async function stubborn() {
  const child = await startStubbornProcess()
  started.push(child)
  return child
}

/** Runs the service until its child is connected, then stops it. */
async function runUntilConnected(overrides: Parameters<SyncFixture["start"]>[0] = {}) {
  const { outcome, stop } = fixture.start(overrides)
  await eventually(() => fixture.logs.includes("event connected"))
  stop()
  return outcome
}

const leftBehind = (pid: number) => `stopping a wacli left behind by an earlier service (pid ${pid})`

describe("a wacli left behind by a killed service", () => {
  test("is stopped with SIGTERM before the child starts", async () => {
    const stale = await idle()
    fixture.fake.setResponses([doctorHeldBy(stale.pid), HANGING_SYNC])

    expect((await runUntilConnected()).state).toBe("stopped")
    expect(fixture.logs).toContain(leftBehind(stale.pid))
    expect(fixture.logs.some((line) => line.includes("killing it"))).toBe(false)
    await eventually(() => !isAlive(stale.pid))
    expect(await fixture.syncCalls()).toHaveLength(1)
  })

  test("is killed when it ignores SIGTERM for the grace period", async () => {
    const stale = await stubborn()
    fixture.fake.setResponses([doctorHeldBy(stale.pid), HANGING_SYNC])

    expect((await runUntilConnected({ staleStopGraceMs: 200 })).state).toBe("stopped")
    expect(fixture.logs).toContain(leftBehind(stale.pid))
    expect(fixture.logs).toContain(`the wacli left behind (pid ${stale.pid}) ignored SIGTERM; killing it`)
    await eventually(() => !isAlive(stale.pid))
  })

  test("is the only thing the service touches: other holders are left alone", async () => {
    const bystander = await idle()
    const cases = [
      doctorHeldBy(process.pid),
      doctorHeldBy(999_999_999),
      doctorHeldBy(bystander.pid, false),
      doctorHeldBy(undefined),
    ]
    for (const doctor of cases) {
      fixture.logs.length = 0
      fixture.fake.setResponses([doctor, HANGING_SYNC])
      expect((await runUntilConnected()).state).toBe("stopped")
      expect(fixture.logs.some((line) => line.startsWith("stopping a wacli"))).toBe(false)
    }
    expect(isAlive(bystander.pid)).toBe(true)
  })

  test.skipIf(process.getuid?.() === 0)("ends the run as failed when it cannot be stopped", async () => {
    // Process 1 exists and is not ours to signal, so the service cannot stop it.
    fixture.fake.setResponses([doctorHeldBy(1), HANGING_SYNC])
    const outcome = await fixture.run({ staleStopGraceMs: 100 })

    expect(outcome).toEqual({ exitCode: 1, state: "failed", reason: STORE_HELD_REASON })
    expect(await fixture.syncCalls()).toEqual([])
    expect(fixture.status()).toMatchObject({ state: "failed", pid: null, reason: STORE_HELD_REASON })
    expect(fixture.leftovers()).toEqual([])
  })

  test("is not waited for once a stop was requested", async () => {
    const stale = await stubborn()
    fixture.fake.setResponses([doctorHeldBy(stale.pid), HANGING_SYNC])
    const { outcome, stop } = fixture.start({ staleStopGraceMs: 60_000 })
    await eventually(() => fixture.logs.includes(leftBehind(stale.pid)))
    stop()

    expect(await outcome).toEqual({ exitCode: 0, state: "stopped" })
    expect(isAlive(stale.pid)).toBe(true)
    expect(await fixture.syncCalls()).toEqual([])
  })
})
