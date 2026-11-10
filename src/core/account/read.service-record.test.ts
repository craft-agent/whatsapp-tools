import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { invoke } from "../tool"
import { labelPaths, type LabelPaths } from "../whatsapp/labels"
import { writeServiceRecord } from "../whatsapp/service-record"
import { writeServiceStatus, type ServiceState } from "../whatsapp/service-status"
import { DOCTOR_OK, shortTempDir } from "../whatsapp/sync.testing"
import { resetWacliCache } from "../whatsapp/wacli"
import { envelope, failure, installFakeWacli, type FakeWacli } from "../whatsapp/wacli.testing"
import { whatsappAccountRead } from "./read"

const START_HINT = "Start the sync service to receive messages for this account."
const GONE_HINT =
  "The program the sync service was installed with is gone, as after an update; install the service again."
const RUNNING_GONE_HINT =
  "The sync service has not stopped, but the program it was installed with is gone, so it will not start again; install the service again."

let stateDir: string
let filesDir: string
let fake: FakeWacli
let originalPath: string | undefined

beforeEach(async () => {
  stateDir = await shortTempDir()
  filesDir = await shortTempDir()
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
  rmSync(filesDir, { recursive: true, force: true })
})

/** The label's directory, with the sync service in `state` (its lock held by this process when `live`). */
function label(state?: ServiceState, live = false): LabelPaths {
  const paths = labelPaths(stateDir, "main")
  mkdirSync(paths.dir)
  if (state !== undefined) {
    writeServiceStatus(paths, { state, pid: live ? process.pid : null, since: new Date().toISOString() })
  }
  if (live) writeFileSync(paths.serviceLock, String(process.pid))
  return paths
}

/** Writes a record whose files exist unless named in `missing`. */
async function record(paths: LabelPaths, missing: Array<"program" | "script"> = []) {
  const program = join(filesDir, "program")
  const script = join(filesDir, "script.js")
  if (!missing.includes("program")) writeFileSync(program, "")
  if (!missing.includes("script")) writeFileSync(script, "")
  await writeServiceRecord(paths, { program, script })
  return { program, script }
}

async function read() {
  const [account] = (await invoke(whatsappAccountRead, {}, { cwd: stateDir, stateDir })).accounts
  return account
}

describe("account read: service record", () => {
  test("a record with both files present changes nothing", async () => {
    await record(label("stopped"))
    const account = await read()
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(START_HINT)
  })

  test("no record changes nothing", async () => {
    label("stopped")
    const account = await read()
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(START_HINT)
  })

  test.each<"program" | "script">(["program", "script"])("a stopped service with the %s gone", async (gone) => {
    await record(label("stopped"), [gone])
    const account = await read()
    expect(account?.service).toBe("stopped")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test("a service that never ran, with the program gone", async () => {
    await record(label(), ["program"])
    const account = await read()
    expect(account?.service).toBe("never_run")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test.each(["running", "starting"] as const)(
    "a %s service whose program is gone will not start again",
    async (state) => {
      await record(label(state, true), ["program"])
      const account = await read()
      expect(account?.service).toBe(state)
      expect(account?.action).toBe("start_service")
      expect(account?.hint).toBe(RUNNING_GONE_HINT)
    },
  )

  test("a running service with its files present needs nothing", async () => {
    await record(label("running", true))
    const account = await read()
    expect(account?.action).toBeNull()
    expect(account?.hint).toBeNull()
  })

  test("a gone program wins over a failed service", async () => {
    await record(label("failed"), ["program"])
    const account = await read()
    expect(account?.service).toBe("failed")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test("a gone program wins over a failed doctor", async () => {
    await record(label("stopped"), ["program"])
    fake.setResponses([{ args: ["doctor"], stderr: failure("cannot read the store"), exit: 1 }])
    const account = await read()
    expect(account?.paired).toBeNull()
    expect(account?.error).toContain("cannot read")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test.each([
    ["not_paired", { authenticated: false, session_revoked: false }],
    ["revoked", { authenticated: true, session_revoked: true }],
  ])("pairing still comes first (%s)", async (_name, state) => {
    await record(label("stopped"), ["program"])
    fake.setResponses([{ args: ["doctor"], stdout: envelope(state) }])
    const account = await read()
    expect(account?.action).toBe("pair")
  })

  test("an unsupported wacli still comes first", async () => {
    await fake.cleanup()
    fake = await installFakeWacli({ version: "0.25.0" })
    process.env.PATH = fake.env.PATH
    resetWacliCache()
    await record(label("stopped"), ["program"])
    expect((await read())?.action).toBe("update_wacli")
  })

  test("the result never contains the record's paths", async () => {
    const files = await record(label("stopped"), ["program"])
    const json = JSON.stringify(await read())
    for (const path of [files.program, files.script, filesDir]) expect(json).not.toContain(path)
  })
})
