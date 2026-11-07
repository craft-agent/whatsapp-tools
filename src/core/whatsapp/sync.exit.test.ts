import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DOCTOR_OK, HANGING_SYNC, doctor, eventually, syncFixture, type SyncFixture } from "./sync.testing"
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

/** How many times wacli was asked for `doctor`. */
async function doctorCalls(): Promise<number> {
  return (await fixture.fake.calls()).filter((call) => call.argv.includes("doctor")).length
}

/** Starts a run whose child hangs, and waits until it is connected. */
async function startHanging() {
  fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC])
  const run = fixture.start()
  await eventually(() => fixture.logs.includes("event connected"))
  return run
}

/** Ends the child as a crash would, from outside. */
async function crashChild(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  const [call] = await fixture.syncCalls()
  process.kill(call!.pid, signal)
}

describe("runSync when the session ends", () => {
  test("a child that ends after logged_out is revoked: exit 0, no restart, no second look at doctor", async () => {
    fixture.fake.setResponses([
      DOCTOR_OK,
      { args: ["sync"], stderrLines: [{ line: eventLine("connected") }, { line: eventLine("logged_out") }], exit: 0 },
    ])
    const outcome = await fixture.run()
    expect(outcome.exitCode).toBe(0)
    expect(outcome.state).toBe("revoked")
    expect(fixture.logs).toContain("event logged_out")
    expect(fixture.status()).toMatchObject({ state: "revoked", pid: null, last_event: { name: "logged_out" } })
    expect(fixture.leftovers()).toEqual([])
    expect(await doctorCalls()).toBe(1)
    expect(await fixture.syncCalls()).toHaveLength(1)
  })

  test("a child that ends otherwise while doctor reports the session revoked is revoked too", async () => {
    const { outcome } = await startHanging()
    fixture.fake.setResponses([doctor({ authenticated: true, session_revoked: true })])
    await crashChild()

    expect(await outcome).toMatchObject({ exitCode: 0, state: "revoked" })
    expect(fixture.status()).toMatchObject({ state: "revoked", pid: null })
    expect(fixture.leftovers()).toEqual([])
    expect(await doctorCalls()).toBe(2)
  })
})

describe("runSync when the child ends on its own", () => {
  test("a child that exits with an error fails the run with exit 1", async () => {
    fixture.fake.setResponses([
      DOCTOR_OK,
      { args: ["sync"], stderrLines: [{ line: eventLine("connected") }, { line: "boom" }], exit: 1 },
    ])
    const outcome = await fixture.run()
    expect(outcome).toEqual({ exitCode: 1, state: "failed", reason: "wacli exited (code 1)" })
    expect(fixture.logs.at(-1)).toBe("sync ended: wacli exited (code 1)")
    expect(fixture.logs).toContain("boom")
    expect(fixture.status()).toMatchObject({ state: "failed", pid: null, reason: "wacli exited (code 1)" })
    expect(fixture.leftovers()).toEqual([])
    expect(await doctorCalls()).toBe(2)
    expect(await fixture.syncCalls()).toHaveLength(1)
  })

  test("a child that exits 0 without logged_out still fails the run, so the system starts it again", async () => {
    fixture.fake.setResponses([DOCTOR_OK, { args: ["sync"], exit: 0 }])
    expect(await fixture.run()).toEqual({ exitCode: 1, state: "failed", reason: "wacli exited (code 0)" })
  })

  test("a child ended by a signal fails the run, naming the signal", async () => {
    const { outcome } = await startHanging()
    await crashChild("SIGKILL")
    expect(await outcome).toEqual({ exitCode: 1, state: "failed", reason: "wacli exited (signal SIGKILL)" })
    expect(fixture.leftovers()).toEqual([])
  })

  test("a doctor that cannot answer after the exit does not change why the child ended", async () => {
    const { outcome } = await startHanging()
    fixture.fake.setResponses([{ args: ["doctor"], stderr: "broken\n", exit: 1 }])
    await crashChild()
    expect(await outcome).toMatchObject({ exitCode: 1, state: "failed" })
  })

  test("a doctor that says the session is usable leaves the failure a failure", async () => {
    const { outcome } = await startHanging()
    await crashChild()
    expect(await outcome).toMatchObject({ exitCode: 1, state: "failed" })
  })

  test("a child that fails masks numbers in the status and the log", async () => {
    fixture.fake.setResponses([
      DOCTOR_OK,
      { args: ["sync"], stderrLines: [{ line: "failed for +15551234567" }], exit: 1 },
    ])
    await fixture.run()
    expect(fixture.logs).toContain("failed for <number>")
    expect(fixture.logs.join("\n")).not.toContain("5551234567")
  })

  test("a stop requested while the child ends is a stop, not a failure", async () => {
    const { outcome, stop } = await startHanging()
    stop()
    await crashChild().catch(() => {})
    expect((await outcome).exitCode).toBe(0)
  })
})
