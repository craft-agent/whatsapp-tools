import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { ToolError } from "../errors"
import { writeServiceStatus } from "./service-status"
import { resetWacliCache } from "./wacli"
import { ALREADY_RUNNING_REASON } from "./sync"
import {
  DOCTOR_OK,
  HANGING_SYNC,
  doctor,
  eventually,
  startIdleProcess,
  syncFixture,
  type SyncFixture,
} from "./sync.testing"
import { envelope, failure, installFakeWacli } from "./wacli.testing"

let fixture: SyncFixture

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

/** The commands the fake wacli was asked to run, version checks left out. */
async function commands(): Promise<string[]> {
  return (await fixture.fake.calls()).filter((call) => call.argv[0] !== "version").map((call) => call.argv.join(" "))
}

describe("runSync without a session", () => {
  test("exits 0 as not_paired when no device is paired, without starting the child", async () => {
    fixture.fake.setResponses([doctor({ authenticated: false, session_revoked: false }), HANGING_SYNC])
    const outcome = await fixture.run()
    expect(outcome.exitCode).toBe(0)
    expect(outcome.state).toBe("not_paired")
    expect(await fixture.syncCalls()).toEqual([])
    expect(fixture.status()).toMatchObject({ state: "not_paired", pid: null })
    expect(fixture.logs.at(-1)).toContain("no WhatsApp device is paired")
  })

  test("exits 0 as revoked when WhatsApp revoked the session", async () => {
    fixture.fake.setResponses([doctor({ authenticated: true, session_revoked: true }), HANGING_SYNC])
    const outcome = await fixture.run()
    expect(outcome).toMatchObject({ exitCode: 0, state: "revoked" })
    expect(await fixture.syncCalls()).toEqual([])
    expect(fixture.status()).toMatchObject({ state: "revoked", pid: null })
  })

  test("reads a revoked session that is also unauthenticated as revoked", async () => {
    fixture.fake.setResponses([doctor({ authenticated: false, session_revoked: true })])
    expect((await fixture.run()).state).toBe("revoked")
  })

  test("asks doctor read-only and leaves the lock and the socket behind it", async () => {
    fixture.fake.setResponses([doctor({ authenticated: false, session_revoked: false })])
    await fixture.run()
    expect(await commands()).toEqual([`--store ${fixture.paths.store} --json --read-only doctor`])
    expect(fixture.leftovers()).toEqual([])
  })

  test("creates the label's directory with mode 700", async () => {
    fixture.fake.setResponses([doctor({ authenticated: false, session_revoked: false })])
    await fixture.run()
    expect(statSync(fixture.paths.dir).mode & 0o777).toBe(0o700)
  })
})

describe("runSync that cannot start", () => {
  test("fails with exit 1 and leaves the status alone when another service holds the lock", async () => {
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC])
    const holder = await startIdleProcess()
    try {
      await mkdir(fixture.paths.dir, { recursive: true })
      writeFileSync(fixture.paths.serviceLock, `${holder.pid}\n`)
      const running = { state: "running" as const, pid: holder.pid, since: "2026-11-07T05:00:00.000Z" }
      writeServiceStatus(fixture.paths, running)
      const outcome = await fixture.run()
      expect(outcome).toEqual({ exitCode: 1, state: "failed", reason: ALREADY_RUNNING_REASON })
      expect(fixture.logs.at(-1)).toBe(ALREADY_RUNNING_REASON)
      expect(await fixture.fake.calls()).toEqual([])
      expect(fixture.status()).toEqual(running)
      expect(readFileSync(fixture.paths.serviceLock, "utf8").trim()).toBe(String(holder.pid))
      expect(existsSync(fixture.paths.socket)).toBe(false)
    } finally {
      holder.kill("SIGKILL")
    }
  })

  test("takes over a lock whose process is gone", async () => {
    fixture.fake.setResponses([doctor({ authenticated: false, session_revoked: false })])
    await mkdir(fixture.paths.dir, { recursive: true })
    writeFileSync(fixture.paths.serviceLock, "999999999\n")
    expect((await fixture.run()).state).toBe("not_paired")
    expect(fixture.leftovers()).toEqual([])
  })

  test("fails with exit 1 when wacli is older than the supported version", async () => {
    const old = await installFakeWacli({ version: "0.25.0" })
    try {
      const outcome = await fixture.run({ env: old.env })
      expect(outcome.exitCode).toBe(1)
      expect(outcome.state).toBe("failed")
      expect(outcome.reason).toContain("update wacli")
      expect(fixture.status()).toMatchObject({ state: "failed", pid: null })
      expect(fixture.leftovers()).toEqual([])
    } finally {
      await old.cleanup()
    }
  })

  test("fails with exit 1 when doctor fails, with the error's text", async () => {
    fixture.fake.setResponses([{ args: ["doctor"], stderr: failure("something broke"), exit: 1 }])
    const outcome = await fixture.run()
    expect(outcome.exitCode).toBe(1)
    expect(outcome.state).toBe("failed")
    expect(outcome.reason).toContain("something broke")
    expect(fixture.leftovers()).toEqual([])
  })

  test("fails with exit 1 when doctor answers something that is not a result", async () => {
    fixture.fake.setResponses([{ args: ["doctor"], stdout: "hello\n" }])
    expect((await fixture.run()).exitCode).toBe(1)
  })

  test("treats a doctor answer without the fields as usable and starts the child", async () => {
    fixture.fake.setResponses([{ args: ["doctor"], stdout: envelope({}) }, HANGING_SYNC])
    const { outcome, stop } = fixture.start()
    await eventually(() => fixture.logs.includes("event connected"))
    stop()
    expect((await outcome).state).toBe("stopped")
  })

  test("a stop requested before anything started ends as stopped without touching wacli", async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await fixture.run({ signal: controller.signal })
    expect(outcome).toEqual({ exitCode: 0, state: "stopped" })
    expect(await commands()).toEqual([])
    expect(fixture.status()?.state).toBe("stopped")
  })

  test("refuses an invalid label by throwing", async () => {
    const error = await fixture.run({ label: "Bad Label" }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
  })
})
