import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../errors"
import {
  AUTH_OK,
  NOT_PAIRED,
  PAIR_CODE,
  PHONE,
  PHONE_DIGITS,
  QR_PAYLOAD,
  REVOKED,
  pairingFixture,
  type PairingFixture,
} from "./pairing.testing"
import { DOCTOR_OK, shortTempDir } from "./sync.testing"
import { resetWacliCache } from "./wacli"

let fixture: PairingFixture

beforeEach(() => resetWacliCache())

afterEach(async () => {
  await fixture.cleanup()
})

/** The error a call rejected with. */
async function failureOf(call: Promise<unknown>): Promise<ToolError> {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(ToolError)
  return error as ToolError
}

describe("pairDevice", () => {
  test("hands the codes over as wacli wrote them, and reports what the first sync stored", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_OK])

    const result = await fixture.pair()

    expect(result).toEqual({ messagesStored: 12 })
    expect(fixture.qrCodes).toEqual([QR_PAYLOAD])
    expect(fixture.pairCodes).toEqual([PAIR_CODE])
    expect(statSync(fixture.paths.dir).mode & 0o777).toBe(0o700)
  })

  test("runs auth on the label's store, with the label's environment and no phone by default", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_OK])
    await fixture.pair()

    const [call, ...others] = await fixture.authCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual(["--store", fixture.paths.store, "--json", "auth", "--events"])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test("passes the phone's digits to pair with a code typed on the phone", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_OK])
    await fixture.pair({ phone: PHONE })

    const [call] = await fixture.authCalls()
    expect(call!.argv).toEqual(["--store", fixture.paths.store, "--json", "auth", "--events", "--phone", PHONE_DIGITS])
  })

  test("reports null when wacli does not say how many messages arrived", async () => {
    fixture = await pairingFixture([
      NOT_PAIRED,
      { ...AUTH_OK, stdout: '{"success":true,"data":{"authenticated":true}}\n' },
    ])
    expect(await fixture.pair()).toEqual({ messagesStored: null })
  })

  test.each([
    "12345",
    "abc",
    "+1 555 000 0000 0000 0000",
    "1555--0000",
    "++15550000000",
    "+1 (555) 000 0000",
    "15550000000x",
  ])("refuses the phone %j without starting wacli, and without repeating it", async (phone) => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_OK])

    const error = await failureOf(fixture.pair({ phone }))

    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain(phone)
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("refuses a label that is not valid", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_OK])
    const error = await failureOf(fixture.pair({ label: "Bad Label" }))
    expect(error.code).toBe("invalid_argument")
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("refuses while the label's sync service runs, before wacli is asked anything", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_OK])
    mkdirSync(fixture.paths.dir, { recursive: true })
    writeFileSync(fixture.paths.serviceLock, `${process.pid}\n`)

    const error = await failureOf(fixture.pair())

    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("stop its sync service first")
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("pairs when the service lock names a process that is gone", async () => {
    fixture = await pairingFixture([NOT_PAIRED, AUTH_OK])
    mkdirSync(fixture.paths.dir, { recursive: true })
    writeFileSync(fixture.paths.serviceLock, "2147483646\n")

    expect(await fixture.pair()).toEqual({ messagesStored: 12 })
  })

  test("refuses a label that is paired, without running auth", async () => {
    fixture = await pairingFixture([DOCTOR_OK, AUTH_OK])

    const error = await failureOf(fixture.pair())

    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("already paired")
    expect(error.message).toContain("remove it first")
    expect(await fixture.authCalls()).toEqual([])
  })

  test("deletes a revoked session's files and nothing else before it pairs again", async () => {
    fixture = await pairingFixture([REVOKED, AUTH_OK])
    const { store } = fixture.paths
    mkdirSync(join(store, "media"), { recursive: true })
    const kept = ["wacli.db", "wacli.db-wal", "LOCK", join("media", "photo.bin")].map((name) => join(store, name))
    const session = ["session.db", "session.db-wal", "session.db-shm"].map((name) => join(store, name))
    for (const path of [...kept, ...session]) writeFileSync(path, "x")

    expect(await fixture.pair()).toEqual({ messagesStored: 12 })

    for (const path of session) expect(existsSync(path)).toBe(false)
    for (const path of kept) expect(existsSync(path)).toBe(true)
    expect((await fixture.authCalls()).length).toBe(1)
  })

  test("pairs a revoked label that has only some of the session's files", async () => {
    fixture = await pairingFixture([REVOKED, AUTH_OK])
    mkdirSync(fixture.paths.store, { recursive: true })
    writeFileSync(join(fixture.paths.store, "session.db"), "x")

    expect(await fixture.pair()).toEqual({ messagesStored: 12 })
    expect(existsSync(join(fixture.paths.store, "session.db"))).toBe(false)
  })

  describe("clearing a revoked session", () => {
    let elsewhere: string

    beforeEach(async () => {
      elsewhere = await shortTempDir()
    })

    afterEach(async () => {
      await rm(elsewhere, { recursive: true, force: true })
    })

    test("refuses a store that is a link to another directory, deleting nothing", async () => {
      fixture = await pairingFixture([REVOKED, AUTH_OK])
      writeFileSync(join(elsewhere, "session.db"), "keys")
      mkdirSync(fixture.paths.dir, { recursive: true })
      symlinkSync(elsewhere, fixture.paths.store)

      const error = await failureOf(fixture.pair())

      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("nothing was deleted")
      expect(readFileSync(join(elsewhere, "session.db"), "utf8")).toBe("keys")
      expect(await fixture.authCalls()).toEqual([])
    })

    test("refuses a store that is a file, deleting nothing", async () => {
      fixture = await pairingFixture([REVOKED, AUTH_OK])
      mkdirSync(fixture.paths.dir, { recursive: true })
      writeFileSync(fixture.paths.store, "not a directory")

      expect((await failureOf(fixture.pair())).code).toBe("invalid_argument")
      expect(readFileSync(fixture.paths.store, "utf8")).toBe("not a directory")
      expect(await fixture.authCalls()).toEqual([])
    })

    test("deletes only regular files: a session file that is a link or a directory stays", async () => {
      fixture = await pairingFixture([REVOKED, AUTH_OK])
      const { store } = fixture.paths
      mkdirSync(store, { recursive: true })
      writeFileSync(join(elsewhere, "target"), "keys")
      symlinkSync(join(elsewhere, "target"), join(store, "session.db"))
      mkdirSync(join(store, "session.db-wal"))
      writeFileSync(join(store, "session.db-shm"), "x")

      expect(await fixture.pair()).toEqual({ messagesStored: 12 })

      expect(lstatSync(join(store, "session.db")).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(elsewhere, "target"), "utf8")).toBe("keys")
      expect(lstatSync(join(store, "session.db-wal")).isDirectory()).toBe(true)
      expect(existsSync(join(store, "session.db-shm"))).toBe(false)
    })
  })
})
