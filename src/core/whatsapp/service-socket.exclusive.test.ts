import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import { callService } from "./service-client"
import { eventually, gate, startService, syncFixture, untilAborted, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"

let fixture: SyncFixture

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

const call = (op: string, args?: unknown) => callService(fixture.paths, op, args, { mode: "write" })

/** The sync children the fake started so far. */
const starts = async () => (await fixture.syncCalls()).length

/** Waits until the child has been started again and is running. */
async function childBack(total: number): Promise<void> {
  await eventually(async () => (await starts()) === total && fixture.status()?.state === "running")
}

/** What the service looks like from inside an operation: the status it records and whether its child was stopped. */
async function surroundings() {
  return {
    state: fixture.status()?.state,
    stopped: fixture.logs.filter((line) => line === "event stopping").length,
    starts: await starts(),
  }
}

describe("a delegated operation", () => {
  test("runs while the child runs", async () => {
    const { outcome, stop } = await startService(fixture, {
      look: { kind: "delegated", writes: true, run: surroundings },
    })
    expect(await call("look")).toEqual({ state: "running", stopped: 0, starts: 1 })
    stop()
    await outcome
  })

  test("is not run, and answered as upstream_error, once the child has ended", async () => {
    const started = gate()
    const ran: string[] = []
    const { outcome } = await startService(fixture, {
      hold: { kind: "delegated", writes: true, run: (_args, { signal }) => untilAborted(signal, started.open) },
      mark: { kind: "delegated", writes: true, run: async () => ran.push("mark") },
    })
    const holding = call("hold").catch((caught: unknown) => caught)
    await started.opened
    const queued = call("mark").catch((caught: unknown) => caught)
    const [child] = await fixture.syncCalls()
    process.kill(child!.pid, "SIGKILL")

    expect(((await holding) as ToolError).code).toBe("uncertain")
    const refused = (await queued) as ToolError
    expect(refused).toBeInstanceOf(ToolError)
    expect(refused.code).toBe("upstream_error")
    expect(ran).toEqual([])
    expect(await outcome).toMatchObject({ exitCode: 1, state: "failed" })
  })
})

describe("an exclusive operation", () => {
  test("runs with the child stopped, then starts the child again", async () => {
    const { outcome, stop } = await startService(fixture, {
      look: { kind: "exclusive", writes: true, run: surroundings },
    })
    expect(await call("look")).toEqual({ state: "paused", stopped: 1, starts: 1 })
    await childBack(2)
    stop()
    expect(await outcome).toEqual({ exitCode: 0, state: "stopped" })
  })

  test("starts the child again when the operation throws a ToolError, and returns its code", async () => {
    const { outcome, stop } = await startService(fixture, {
      fail: { kind: "exclusive", writes: true, run: () => Promise.reject(new ToolError("not_found", "no such thing")) },
      look: { kind: "delegated", writes: true, run: surroundings },
    })
    const error = (await call("fail").catch((caught: unknown) => caught)) as ToolError
    expect(error).toBeInstanceOf(ToolError)
    expect([error.code, error.message]).toEqual(["not_found", "no such thing"])
    await childBack(2)
    expect(await call("look")).toMatchObject({ state: "running", starts: 2 })
    stop()
    await outcome
  })

  test("starts the child again when the operation throws anything else, and hides the error's text", async () => {
    const { outcome, stop } = await startService(fixture, {
      fail: { kind: "exclusive", writes: true, run: () => Promise.reject(new Error("broke for +15551234567")) },
    })
    const error = (await call("fail").catch((caught: unknown) => caught)) as ToolError
    expect(error.code).toBe("internal_error")
    expect(error.message).not.toContain("broke")
    await childBack(2)
    expect(fixture.logs.join("\n")).not.toContain("5551234567")
    expect(fixture.logs).toContain('operation "fail" failed: Error: broke for <number>')
    stop()
    await outcome
  })

  test("runs the next request only after the child is back", async () => {
    const order: string[] = []
    const { outcome, stop } = await startService(fixture, {
      first: {
        kind: "exclusive",
        writes: true,
        async run() {
          order.push(`first at ${(await surroundings()).state}`)
        },
      },
      second: {
        kind: "delegated",
        writes: true,
        async run() {
          order.push(`second at ${(await surroundings()).state}`)
        },
      },
    })
    await Promise.all([call("first"), call("second")])
    expect(order).toEqual(["first at paused", "second at running"])
    await childBack(2)
    stop()
    await outcome
  })

  test("ends the run as failed when the child cannot be started again", async () => {
    const { outcome } = await startService(fixture, {
      remove: { kind: "exclusive", writes: true, run: () => rm(join(fixture.fake.dir, "wacli")).then(() => "done") },
    })
    expect(await call("remove")).toBe("done")

    const result = await outcome
    expect(result.exitCode).toBe(1)
    expect(result.state).toBe("failed")
    expect(result.reason).toContain("could not be started")
    expect(fixture.status()).toMatchObject({ state: "failed", pid: null })
    expect(fixture.leftovers()).toEqual([])
  })

  test("a stop during the operation gives up on it as uncertain and does not start the child again", async () => {
    const started = gate()
    const { outcome, stop } = await startService(fixture, {
      wait: { kind: "exclusive", writes: true, run: (_args, { signal }) => untilAborted(signal, started.open) },
    })
    const pending = call("wait").catch((caught: unknown) => caught)
    await started.opened
    stop()

    expect(((await pending) as ToolError).code).toBe("uncertain")
    expect(await outcome).toEqual({ exitCode: 0, state: "stopped" })
    expect(await starts()).toBe(1)
    expect(fixture.status()).toMatchObject({ state: "stopped", pid: null })
    expect(fixture.leftovers()).toEqual([])
  })

  test("answers a request that waits while the service stops as not run", async () => {
    const started = gate()
    const ran: string[] = []
    const { outcome, stop } = await startService(fixture, {
      wait: { kind: "delegated", writes: true, run: (_args, { signal }) => untilAborted(signal, started.open) },
      mark: { kind: "delegated", writes: true, run: async () => ran.push("mark") },
    })
    const pending = call("wait").catch((caught: unknown) => caught)
    await started.opened
    const queued = call("mark").catch((caught: unknown) => caught)
    stop()

    expect(((await queued) as ToolError).code).toBe("upstream_error")
    expect(((await pending) as ToolError).code).toBe("uncertain")
    expect(ran).toEqual([])
    await outcome
  })
})
