import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { SYNC_ARGS } from "./sync-args"
import { DOCTOR_OK, HANGING_SYNC, eventually, syncFixture, type SyncFixture } from "./sync.testing"
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

/** Waits until the child reported that it is connected. */
const connected = () => eventually(() => fixture.logs.includes("event connected"))

describe("runSync while running", () => {
  test("runs wacli sync with its flags on the label's store, in the label's environment", async () => {
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC])
    const { outcome, stop } = fixture.start()
    await connected()
    stop()
    await outcome

    const [call] = await fixture.syncCalls()
    expect(call!.argv).toEqual(["--store", fixture.paths.store, "--json", ...SYNC_ARGS])
    expect(call!.argv).not.toContain("--read-only")
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test("records the running state with the service's process id and the last event", async () => {
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC])
    const now = new Date("2026-11-07T05:03:12.345Z")
    const { outcome, stop } = fixture.start({ now: () => now })
    await connected()
    expect(fixture.status()).toEqual({
      state: "running",
      pid: process.pid,
      since: now.toISOString(),
      last_event: { name: "connected", at: now.toISOString() },
    })
    stop()
    await outcome
  })

  test("serves its socket, readable by the owner only, while it runs", async () => {
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC])
    const { outcome, stop } = fixture.start()
    await connected()
    expect(statSync(fixture.paths.socket).isSocket()).toBe(true)
    expect(statSync(fixture.paths.socket).mode & 0o777).toBe(0o600)
    expect(statSync(fixture.paths.serviceLock).isFile()).toBe(true)
    stop()
    await outcome
  })

  test("logs each event as one line with only harmless fields, and masks everything", async () => {
    fixture.fake.setResponses([
      DOCTOR_OK,
      {
        ...HANGING_SYNC,
        stderrLines: [
          { line: eventLine("connected") },
          {
            line: eventLine("progress", {
              count: 3,
              ok: true,
              reason: "stale stream",
              jid: "15551234567@s.whatsapp.net",
              name: "Alice Example",
              phone: "+15551234567",
              at: 1730000000000,
              nested: { jid: "15551234567@s.whatsapp.net" },
            }),
          },
          { line: eventLine("reconnecting", { attempt: 2 }) },
          { line: "syncing messages for +15551234567 (15551234567@s.whatsapp.net)" },
          { line: "{not json 15551234567" },
          { line: `{"event":"Bad Name!","data":{}}` },
        ],
      },
    ])
    const { outcome, stop } = fixture.start()
    await eventually(() => fixture.logs.includes("{not json <number>"))
    stop()
    await outcome

    expect(fixture.logs).toContain("event connected")
    expect(fixture.logs).toContain("event progress count=3 ok=true reason=stale_stream")
    expect(fixture.logs).toContain("event reconnecting attempt=2")
    expect(fixture.logs).toContain("syncing messages for <number> (<number>@s.whatsapp.net)")
    expect(fixture.logs).toContain(`{"event":"Bad Name!","data":{}}`)
    const text = fixture.logs.join("\n")
    expect(text).not.toContain("5551234567")
    expect(text).not.toContain("Alice")
  })

  test("does not rewrite the status for events that come in bursts, but records them with the next write", async () => {
    fixture.fake.setResponses([
      DOCTOR_OK,
      {
        ...HANGING_SYNC,
        onTerm: { exit: 0 },
        stderrLines: [{ line: eventLine("connected") }, { line: eventLine("progress") }],
      },
    ])
    const { outcome, stop } = fixture.start()
    await eventually(() => fixture.logs.includes("event progress"))
    expect(fixture.status()?.last_event?.name).toBe("connected")
    stop()
    await outcome
    expect(fixture.status()?.last_event?.name).toBe("progress")
  })
})

describe("runSync when stopped", () => {
  test("stops the child gracefully and exits 0 as stopped, with nothing left behind", async () => {
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC])
    const { outcome, stop } = fixture.start()
    await connected()
    stop()

    expect(await outcome).toEqual({ exitCode: 0, state: "stopped" })
    expect(fixture.logs).toContain("event stopping")
    expect(fixture.logs.at(-1)).toBe("stopped")
    expect(fixture.status()).toMatchObject({ state: "stopped", pid: null })
    expect(fixture.leftovers()).toEqual([])
    expect(await fixture.syncCalls()).toHaveLength(1)
  })

  test("a second run can start once the first stopped", async () => {
    fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC])
    const first = fixture.start()
    await connected()
    first.stop()
    await first.outcome

    fixture.logs.length = 0
    const second = fixture.start()
    await connected()
    second.stop()
    expect((await second.outcome).state).toBe("stopped")
    expect(await fixture.syncCalls()).toHaveLength(2)
  })
})
