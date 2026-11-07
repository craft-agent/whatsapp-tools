import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { formatLocalTime } from "../time"
import { annotations, invoke } from "../tool"
import { labelPaths } from "../whatsapp/labels"
import { writeServiceStatus, type ServiceState } from "../whatsapp/service-status"
import { DOCTOR_OK, shortTempDir } from "../whatsapp/sync.testing"
import { FALLBACK_DIRS, resetWacliCache } from "../whatsapp/wacli"
import { envelope, failure, installFakeWacli, type FakeWacli } from "../whatsapp/wacli.testing"
import { whatsappAccountRead } from "./read"

const STALE_LOCK_PID = 2_147_483_647

let stateDir: string
let fake: FakeWacli
let originalPath: string | undefined

beforeEach(async () => {
  stateDir = await shortTempDir()
  fake = await installFakeWacli()
  fake.setResponses([DOCTOR_OK])
  originalPath = process.env.PATH
  process.env.PATH = fake.env.PATH
  resetWacliCache()
})

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  resetWacliCache()
  await fake.cleanup()
  rmSync(stateDir, { recursive: true, force: true })
})

function label(name = "main") {
  const paths = labelPaths(stateDir, name)
  mkdirSync(paths.dir)
  return paths
}

function read(args: unknown = {}, signal?: AbortSignal) {
  return invoke(whatsappAccountRead, args, { cwd: stateDir, stateDir, signal })
}

function status(state: ServiceState, live: boolean | "stale" = false, reason?: string) {
  const paths = label()
  writeServiceStatus(paths, { state, pid: live === true ? process.pid : null, since: new Date().toISOString(), reason })
  if (live) writeFileSync(paths.serviceLock, String(live === true ? process.pid : STALE_LOCK_PID))
  return paths
}

describe("account read: selection and contract", () => {
  test("publishes read annotations", () => {
    expect(annotations(whatsappAccountRead)).toEqual({
      title: "Read account status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("no labels returns an empty list without creating state", async () => {
    rmSync(stateDir, { recursive: true })
    expect(await read()).toEqual({ wacli: { version: "0.26.0", supported: true }, accounts: [] })
    expect(existsSync(stateDir)).toBe(false)
    expect((await fake.calls()).map((call) => call.argv)).toEqual([["version"]])
  })

  test("lists sorted labels, or just the named one", async () => {
    label("zebra")
    label("alpha")
    expect((await read()).accounts.map((account) => account.label)).toEqual(["alpha", "zebra"])
    expect((await read({ account: "zebra" })).accounts.map((account) => account.label)).toEqual(["zebra"])
  })

  test("unknown account fails as pickLabel does", async () => {
    label()
    await expect(read({ account: "missing" })).rejects.toMatchObject({
      code: "not_found",
      message: 'WhatsApp account "missing" was not found; known accounts: main.',
    })
  })

  test("unknown account with no labels says none is paired", async () => {
    await expect(read({ account: "missing" })).rejects.toMatchObject({
      code: "not_found",
      message: 'WhatsApp account "missing" was not found; no WhatsApp account is paired yet.',
    })
  })

  test.each([{ account: "../other" }, { account: "Bad" }, { account: 1 }, { extra: true }])(
    "refuses invalid arguments %j",
    async (args) => {
      await expect(read(args)).rejects.toMatchObject({ code: "invalid_argument" })
    },
  )

  test("missing state directory is an entry-point bug", async () => {
    await expect(invoke(whatsappAccountRead, {}, { cwd: stateDir })).rejects.toMatchObject({ code: "internal_error" })
  })
})

describe("account read: doctor and wacli", () => {
  test.each([
    { authenticated: true, session_revoked: false, paired: "paired", action: "start_service" },
    { authenticated: false, session_revoked: false, paired: "not_paired", action: "pair" },
    { authenticated: false, session_revoked: true, paired: "revoked", action: "pair" },
    { authenticated: true, session_revoked: true, paired: "revoked", action: "pair" },
  ])("pairing and next step: %j", async ({ authenticated, session_revoked, paired, action }) => {
    label()
    fake.setResponses([{ args: ["doctor"], stdout: envelope({ authenticated, session_revoked }) }])
    const [account] = (await read()).accounts
    expect(account).toMatchObject({
      paired,
      action,
      service: "never_run",
      last_sync_at: null,
      last_activity_at: null,
      error: null,
    })
    expect(account?.hint).toBeString()
  })

  test("projects only safe fields, converts timestamps, and reads only its store", async () => {
    const paths = label()
    const sync = "2026-11-07T05:03:12.345Z"
    const activity = "2026-11-07T14:04:13+09:00"
    const secrets = ["15550001234@s.whatsapp.net", "+15550001234", "private-session-key", "private message content"]
    fake.setResponses([
      {
        args: ["doctor"],
        stdout: envelope({
          authenticated: true,
          linked_jid: secrets[0],
          number: secrets[1],
          keys: secrets[2],
          text: secrets[3],
          store: { last_sync_at: sync, last_activity_at: activity },
        }),
      },
    ])
    const result = await read()
    expect(result.accounts[0]).toMatchObject({
      last_sync_at: formatLocalTime(Date.parse(sync)),
      last_activity_at: formatLocalTime(Date.parse(activity)),
    })
    for (const secret of secrets) expect(JSON.stringify(result)).not.toContain(secret)
    expect((await fake.calls()).find((call) => call.argv.includes("doctor"))?.argv).toEqual([
      "--store",
      paths.store,
      "--json",
      "--read-only",
      "doctor",
    ])
    expect(existsSync(paths.store)).toBe(false)
  })

  test.each([{}, { last_sync_at: null, last_activity_at: "bad" }])(
    "missing or invalid timestamps are null: %j",
    async (store) => {
      label()
      fake.setResponses([{ args: ["doctor"], stdout: envelope({ authenticated: true, store }) }])
      expect((await read()).accounts[0]).toMatchObject({ last_sync_at: null, last_activity_at: null })
    },
  )

  test("doctor failure is masked, unknown pairing and check_service", async () => {
    status("stopped", false, "Previous failure")
    fake.setResponses([
      { args: ["doctor"], stderr: failure("cannot read 15550001234@s.whatsapp.net +15550001234"), exit: 1 },
    ])
    const [account] = (await read()).accounts
    expect(account).toMatchObject({ paired: null, action: "check_service", service: "stopped" })
    expect(account?.error).toContain("cannot read")
    expect(JSON.stringify(account)).not.toContain("15550001234")
    expect(JSON.stringify(account)).not.toContain("15550001234@s.whatsapp.net")
  })

  test.each([null, {}, { authenticated: "true" }, { authenticated: true, session_revoked: "no" }])(
    "an unreadable doctor report (%p) is a doctor error, not a reason to pair",
    async (report) => {
      label()
      fake.setResponses([{ args: ["doctor"], stdout: envelope(report) }])
      expect((await read()).accounts[0]).toMatchObject({
        paired: null,
        action: "check_service",
        error: "wacli doctor returned an unreadable report.",
      })
    },
  )

  test("masks a number a status file's reason carries, whoever wrote it", async () => {
    const paths = label()
    const raw = {
      state: "failed",
      pid: null,
      since: new Date().toISOString(),
      reason: "lost 15550001234@s.whatsapp.net",
    }
    writeFileSync(paths.serviceStatus, JSON.stringify(raw))
    fake.setResponses([{ args: ["doctor"], stdout: envelope(DOCTOR_OK) }])
    const [account] = (await read()).accounts
    expect(account?.service).toBe("failed")
    expect(JSON.stringify(account)).not.toContain("15550001234")
  })

  test("cancellation is not reported as account health", async () => {
    label()
    const controller = new AbortController()
    controller.abort()
    await expect(read({}, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })

  test("an old wacli returns its version and update action without running doctor", async () => {
    await fake.cleanup()
    fake = await installFakeWacli({ version: "0.25.0" })
    process.env.PATH = fake.env.PATH
    status("failed")
    const result = await read()
    expect(result.wacli).toEqual({ version: "0.25.0", supported: false })
    expect(result.accounts[0]).toMatchObject({ paired: null, action: "update_wacli" })
    expect((await fake.calls()).map((call) => call.argv)).toEqual([["version"]])
  })

  test.skipIf(FALLBACK_DIRS.some((dir) => existsSync(join(dir, "wacli"))))(
    "missing wacli returns install action for every label",
    async () => {
      process.env.PATH = stateDir
      label("alpha")
      label("zebra")
      const result = await read()
      expect(result.wacli).toEqual({ version: null, supported: false })
      expect(result.accounts).toHaveLength(2)
      for (const account of result.accounts) expect(account).toMatchObject({ paired: null, action: "install_wacli" })
      expect(await fake.calls()).toEqual([])
    },
  )
})

describe("account read: service state", () => {
  test.each(["starting", "running", "paused"] as const)("a live lock preserves %s", async (state) => {
    status(state, true)
    expect((await read()).accounts[0]).toMatchObject({ service: state, action: null, hint: null })
  })

  test.each(["stopped", "failed", "not_paired", "revoked"] as const)("a live lock overrides %s", async (state) => {
    status(state, true)
    expect((await read()).accounts[0]).toMatchObject({ service: "running", action: null })
  })

  test("a live lock without status means running", async () => {
    const paths = label()
    writeFileSync(paths.serviceLock, String(process.pid))
    expect((await read()).accounts[0]).toMatchObject({ service: "running", action: null })
  })

  test.each(["starting", "running", "paused"] as const)("%s without a live lock means failed", async (state) => {
    const paths = status(state, "stale")
    expect((await read()).accounts[0]).toMatchObject({ service: "failed", action: "check_service" })
    rmSync(paths.serviceLock)
    expect((await read()).accounts[0]).toMatchObject({ service: "failed", action: "check_service" })
  })

  test.each(["stopped", "not_paired", "revoked"] as const)(
    "%s without a lock is stopped; fresh pairing needs service",
    async (state) => {
      status(state)
      expect((await read()).accounts[0]).toMatchObject({
        paired: "paired",
        service: "stopped",
        action: "start_service",
      })
    },
  )

  test("failed keeps the service error and asks to check its log", async () => {
    status("failed", false, "The child stopped unexpectedly.")
    const [account] = (await read()).accounts
    expect(account).toMatchObject({
      service: "failed",
      error: "The child stopped unexpectedly.",
      action: "check_service",
    })
    expect(account?.hint).toContain("log")
  })

  test.each([false, true])("pairing takes precedence over failed service (revoked: %s)", async (revoked) => {
    status("failed")
    fake.setResponses([{ args: ["doctor"], stdout: envelope({ authenticated: false, session_revoked: revoked }) }])
    expect((await read()).accounts[0]?.action).toBe("pair")
  })
})
