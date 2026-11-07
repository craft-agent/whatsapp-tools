import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { callService } from "./service-client"
import type { ServiceOperations } from "./service-socket"
import { gate, startService, syncFixture, untilAborted, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"

let fixture: SyncFixture

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

const call = (op: string, timeoutMs?: number) => callService(fixture.paths, op, undefined, { mode: "ask", timeoutMs })

/** The error a call rejects with. */
async function failureOf(pending: Promise<unknown>): Promise<ToolError> {
  const error = await pending.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ToolError)
  return error as ToolError
}

/** An operation that waits until it is aborted, as one that waits for WhatsApp does; `started` is told first. */
function waiting(kind: "delegated" | "exclusive", writes: boolean, started?: () => void): ServiceOperations {
  return { wait: { kind, writes, run: (_args, { signal }) => untilAborted(signal, started) } }
}

describe("an operation that does not write", () => {
  // Delegated only: an exclusive operation answers after the child has started again, which under load can outlast
  // the client's grace past the deadline; the answer itself does not depend on the kind.
  test("answers upstream_error, not uncertain, when its deadline passes while it runs", async () => {
    const { outcome, stop } = await startService(fixture, waiting("delegated", false))
    const error = await failureOf(call("wait", 100))
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("ran out of time before WhatsApp answered; nothing was changed")
    stop()
    await outcome
  })

  for (const kind of ["delegated", "exclusive"] as const) {
    test(`answers upstream_error when the service stops while it runs (${kind})`, async () => {
      const started = gate()
      const { outcome, stop } = await startService(fixture, waiting(kind, false, started.open))
      const pending = failureOf(call("wait"))
      await started.opened
      stop()
      const error = await pending
      expect(error.code).toBe("upstream_error")
      expect(error.message).toContain("stopped before WhatsApp answered; nothing was changed")
      await outcome
    })
  }

  test("keeps the code of an error it throws", async () => {
    const { outcome, stop } = await startService(fixture, {
      fail: { kind: "delegated", writes: false, run: () => Promise.reject(new ToolError("rate_limited", "slow down")) },
    })
    expect((await failureOf(call("fail"))).code).toBe("rate_limited")
    stop()
    await outcome
  })

  test("is still answered uncertain by a service whose operation writes, for the same stop", async () => {
    const started = gate()
    const { outcome, stop } = await startService(fixture, waiting("delegated", true, started.open))
    const pending = failureOf(call("wait"))
    await started.opened
    stop()
    expect((await pending).code).toBe("uncertain")
    await outcome
  })
})
