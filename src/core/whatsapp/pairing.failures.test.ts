import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { isAbortError, ToolError } from "../errors"
import { isAlive } from "./service-lock"
import {
  AUTH_OK,
  AUTH_WAITING,
  NOT_PAIRED,
  PAIR_CODE,
  PHONE,
  PHONE_DIGITS,
  QR_PAYLOAD,
  authFailing,
  pairingFixture,
  type PairingFixture,
} from "./pairing.testing"
import { eventually } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope } from "./wacli.testing"

let fixture: PairingFixture

beforeEach(() => resetWacliCache())

afterEach(async () => {
  await fixture.cleanup()
})

/** The error a call rejected with. */
async function errorOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => undefined,
    (reason: unknown) => reason,
  )
}

/** Everything a failure could leak: its message, and what the callbacks were not meant to log. */
function leaks(error: unknown): string[] {
  const text = `${(error as Error).message} ${JSON.stringify((error as Error).cause ?? "")}`
  return [QR_PAYLOAD, PAIR_CODE, PHONE_DIGITS, "9876543210"].filter((secret) => text.includes(secret))
}

describe("pairDevice failing", () => {
  test("turns a timed out QR code into an upstream error that says to pair again", async () => {
    fixture = await pairingFixture([
      NOT_PAIRED,
      authFailing("QR code timed out; run `wacli auth` again to get a new code"),
    ])

    const error = (await errorOf(fixture.pair())) as ToolError

    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("No device was paired in time; pair again to get a new code.")
    expect(fixture.qrCodes).toEqual([QR_PAYLOAD])
  })

  test("maps any other failure as a read, with the codes and the phone out of the message", async () => {
    fixture = await pairingFixture([NOT_PAIRED, authFailing(`pairing refused for ${PHONE}`)])

    const error = (await errorOf(fixture.pair({ phone: PHONE }))) as ToolError

    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("pairing refused for <number>")
    expect(leaks(error)).toEqual([])
  })

  test("names the other wacli process when the store is locked", async () => {
    fixture = await pairingFixture([NOT_PAIRED, authFailing("store is locked")])
    const error = (await errorOf(fixture.pair())) as ToolError
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("held by another wacli process")
  })

  test.each([
    ["no output", ""],
    ["a success that is not authenticated", envelope({ authenticated: false })],
    ["a success that does not say", envelope({ messages_stored: 3 })],
  ])("refuses %s", async (_name, stdout) => {
    fixture = await pairingFixture([NOT_PAIRED, { ...AUTH_OK, stdout }])

    const error = (await errorOf(fixture.pair())) as ToolError

    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("printed output that is not a result")
    expect(leaks(error)).toEqual([])
  })

  test("stops wacli and fails when the time runs out", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_WAITING])

    const error = (await errorOf(fixture.pair({ timeoutMs: 300 }))) as ToolError

    expect(error.code).toBe("upstream_error")
    expect(error.message).toBe("No device was paired in time; pair again to get a new code.")
    const [call] = await fixture.authCalls()
    expect(isAlive(call!.pid)).toBe(false)
  })

  test("stops wacli and rejects with an AbortError when aborted", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_WAITING])
    const controller = new AbortController()
    const pairing = errorOf(fixture.pair({ signal: controller.signal }))

    await eventually(() => fixture.pairCodes.length > 0)
    controller.abort()

    const error = await pairing
    expect(isAbortError(error)).toBe(true)
    const [call] = await fixture.authCalls()
    expect(isAlive(call!.pid)).toBe(false)
  })

  test("does nothing when it is aborted already", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_OK])

    const error = await errorOf(fixture.pair({ signal: AbortSignal.abort() }))

    expect(isAbortError(error)).toBe(true)
    expect(await fixture.fake.calls()).toEqual([])
  })
})
