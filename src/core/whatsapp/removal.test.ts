import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError, isAbortError } from "../errors"
import { ensureLabelDir, labelPaths, type LabelPaths } from "./labels"
import { removeLabel, type RemoveLabelOptions } from "./removal"
import { DOCTOR_OK, LABEL, doctor, shortTempDir } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope, failure, installFakeWacli, type FakeResponse, type FakeWacli } from "./wacli.testing"

const LOGOUT_OK: FakeResponse = { args: ["auth", "logout"], stdout: envelope({ logged_out: true }) }
const LOGOUT_FAILS: FakeResponse = { args: ["auth", "logout"], stderr: failure("connect failed"), exit: 1 }

/** A service lock that names a process which is alive, standing in for a service that has not stopped yet. */
const LIVE_LOCK = `${process.pid}\n`

let fake: FakeWacli
let stateDir: string
let paths: LabelPaths

beforeEach(async () => {
  resetWacliCache()
  fake = await installFakeWacli()
  stateDir = await shortTempDir()
  paths = await ensureLabelDir(stateDir, LABEL)
})

afterEach(async () => {
  await fake.cleanup()
  await rm(stateDir, { recursive: true, force: true })
})

/** Removes `LABEL` against the fake; the service is already gone unless `overrides` say otherwise. */
function remove(overrides: Partial<RemoveLabelOptions> = {}) {
  return removeLabel({
    stateDir,
    label: LABEL,
    env: fake.env,
    uninstall: async () => {},
    pollTimeoutMs: 100,
    pollIntervalMs: 10,
    ...overrides,
  })
}

/** The error a call rejected with. */
async function errorOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => undefined,
    (reason: unknown) => reason,
  )
}

/** The fake's calls that ran `auth logout`. */
async function logoutCalls() {
  return (await fake.calls()).filter((call) => call.argv.includes("logout"))
}

describe("removeLabel", () => {
  test("logs a paired device out, then deletes the label's directory and only that", async () => {
    fake.setResponses([DOCTOR_OK, LOGOUT_OK])
    const other = await ensureLabelDir(stateDir, "other")
    mkdirSync(paths.store, { recursive: true })
    writeFileSync(join(paths.store, "session.db"), "x")

    expect(await remove()).toEqual({ loggedOut: true })

    expect(existsSync(paths.dir)).toBe(false)
    expect(existsSync(other.dir)).toBe(true)
    const [call, ...others] = await logoutCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual(["--store", paths.store, "--json", "auth", "logout"])
    expect(call!.argv).not.toContain("--read-only")
  })

  test("still deletes the label when the logout fails, and says it did not happen", async () => {
    fake.setResponses([DOCTOR_OK, LOGOUT_FAILS])

    expect(await remove()).toEqual({ loggedOut: false })

    expect(existsSync(paths.dir)).toBe(false)
    expect((await logoutCalls()).length).toBe(1)
  })

  test.each([
    ["revoked", doctor({ authenticated: false, session_revoked: true })],
    ["not paired", doctor({ authenticated: false, session_revoked: false })],
  ])("does not try to log out a label that is %s", async (_name, answer) => {
    fake.setResponses([answer, LOGOUT_OK])

    expect(await remove()).toEqual({ loggedOut: false })

    expect(existsSync(paths.dir)).toBe(false)
    expect(await logoutCalls()).toEqual([])
  })

  test("deletes the label when wacli cannot say whether it is paired", async () => {
    fake.setResponses([{ args: ["doctor"], stderr: failure("boom"), exit: 1 }, LOGOUT_OK])

    expect(await remove()).toEqual({ loggedOut: false })

    expect(existsSync(paths.dir)).toBe(false)
    expect(await logoutCalls()).toEqual([])
  })

  test("is not_found for a label that does not exist, and uninstalls nothing", async () => {
    let uninstalled = false
    const error = await errorOf(
      remove({
        label: "nobody",
        uninstall: async () => {
          uninstalled = true
        },
      }),
    )

    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("not_found")
    expect((error as ToolError).message).toContain(`known accounts: ${LABEL}.`)
    expect(uninstalled).toBe(false)
    expect(await fake.calls()).toEqual([])
  })

  test("refuses a label directory that is a link", async () => {
    const target = await shortTempDir()
    try {
      symlinkSync(target, labelPaths(stateDir, "linked").dir)

      const error = (await errorOf(remove({ label: "linked" }))) as ToolError

      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("is not a directory")
      expect(existsSync(target)).toBe(true)
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })

  test("waits for the service to exit after the uninstall, then removes", async () => {
    fake.setResponses([DOCTOR_OK, LOGOUT_OK])
    writeFileSync(paths.serviceLock, LIVE_LOCK)
    let uninstalled = false

    const result = await remove({
      pollTimeoutMs: 2_000,
      uninstall: async () => {
        uninstalled = true
        setTimeout(() => rm(paths.serviceLock, { force: true }), 50)
      },
    })

    expect(uninstalled).toBe(true)
    expect(result).toEqual({ loggedOut: true })
    expect(existsSync(paths.dir)).toBe(false)
  })

  test("deletes nothing and asks wacli nothing while the service still runs", async () => {
    fake.setResponses([DOCTOR_OK, LOGOUT_OK])
    writeFileSync(paths.serviceLock, LIVE_LOCK)
    let uninstalled = false
    const start = Date.now()

    const error = (await errorOf(
      remove({
        pollTimeoutMs: 80,
        uninstall: async () => {
          uninstalled = true
        },
      }),
    )) as ToolError

    expect(Date.now() - start).toBeGreaterThanOrEqual(70)
    expect(uninstalled).toBe(true)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("The sync service for this label is still running; stop it first.")
    expect(existsSync(paths.dir)).toBe(true)
    expect(await fake.calls()).toEqual([])
  })

  test("ignores a service lock whose process is gone", async () => {
    fake.setResponses([DOCTOR_OK, LOGOUT_OK])
    writeFileSync(paths.serviceLock, "2147483646\n")

    expect(await remove()).toEqual({ loggedOut: true })
    expect(existsSync(paths.dir)).toBe(false)
  })

  test("deletes nothing when the uninstall fails", async () => {
    const error = (await errorOf(
      remove({
        uninstall: async () => {
          throw new ToolError("upstream_error", "launchctl failed")
        },
      }),
    )) as ToolError

    expect(error.message).toBe("launchctl failed")
    expect(existsSync(paths.dir)).toBe(true)
    expect(await fake.calls()).toEqual([])
  })

  test("deletes nothing when it is aborted while waiting for the service", async () => {
    writeFileSync(paths.serviceLock, LIVE_LOCK)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 30)

    const error = await errorOf(remove({ pollTimeoutMs: 5_000, signal: controller.signal }))

    expect(isAbortError(error)).toBe(true)
    expect(existsSync(paths.dir)).toBe(true)
  })

  test("deletes nothing when it is aborted while wacli is being asked", async () => {
    fake.setResponses([DOCTOR_OK, { ...LOGOUT_OK, hang: true }])
    const controller = new AbortController()
    const removal = errorOf(remove({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 400)

    expect(isAbortError(await removal)).toBe(true)
    expect(existsSync(paths.dir)).toBe(true)
  })
})
