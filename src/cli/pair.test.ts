import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { eventLine } from "../core/whatsapp/wacli.testing"
import {
  AUTH_OK,
  CODE_EVENTS,
  NOT_PAIRED,
  PAIR_CODE,
  PHONE,
  PHONE_DIGITS,
  QR_PAYLOAD,
  authFailing,
} from "../core/whatsapp/pairing.testing"
import { DOCTOR_OK } from "../core/whatsapp/sync.testing"
import { PROJECT } from "../project"
import { commandFixture, type CommandFixture } from "./command.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { runPair } from "./pair"

const SCAN_INSTRUCTION = "On your phone, open WhatsApp > Linked devices > Link a device, and scan this code:"
const PAIR_CODE_STEPS = "WhatsApp > Linked devices > Link a device > Link with phone number instead"
const RENEWED_INSTRUCTION = "WhatsApp renewed the code; scan this one instead:"
/** The fixed 256-colour white and near-black the code is painted with, so it scans on any terminal theme. */
const QR_COLORS = [/\x1b\[48;5;231m/, /\x1b\[38;5;232m/]
/** Moves the cursor up over a drawing and clears from there, to draw a renewed code in its place. */
const REDRAW = /\x1b\[\d+F\x1b\[0J/

const qr = (code: string, afterMs: number) => ({ line: eventLine("qr_code", { code }), afterMs })

let fixture: CommandFixture

afterEach(async () => {
  await fixture.cleanup()
})

describe("runPair", () => {
  test("draws the QR code, prints the pairing code and the next step, and writes no number", async () => {
    fixture = await commandFixture([NOT_PAIRED, AUTH_OK])

    const { code, stdout, stderr } = await fixture.run(runPair)

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain(SCAN_INSTRUCTION)
    for (const color of QR_COLORS) expect(stdout).toMatch(color)
    expect(stdout).not.toContain(QR_PAYLOAD)
    expect(stdout).toContain(PAIR_CODE_STEPS)
    expect(stdout).toContain(`  ${PAIR_CODE}\n`)
    expect(stdout).toContain('Paired "default".')
    expect(stdout).toContain("12 messages arrived while pairing.")
    expect(stdout).toContain(`Start receiving with: ${PROJECT.cli} service install --account default`)
    expect(stdout.indexOf(SCAN_INSTRUCTION)).toBeLessThan(stdout.indexOf("Paired"))
    expect(stderr).toBe("")
    expect(stdout + stderr).not.toContain(PHONE_DIGITS)
    const [call] = (await fixture.fake.calls()).filter((c) => c.argv.includes("auth"))
    expect(call!.argv).toEqual(["--store", fixture.paths("default").store, "--json", "auth", "--events"])
  })

  test("takes the label and the phone", async () => {
    fixture = await commandFixture([NOT_PAIRED, AUTH_OK])

    const { code, stdout } = await fixture.run(runPair, ["--account", "work", `--phone=${PHONE}`])

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain('Paired "work".')
    expect(stdout).toContain("service install --account work")
    const [call] = (await fixture.fake.calls()).filter((c) => c.argv.includes("auth"))
    expect(call!.argv).toEqual([
      "--store",
      fixture.paths("work").store,
      "--json",
      "auth",
      "--events",
      "--phone",
      PHONE_DIGITS,
    ])
  })

  test("asks for the full history and says the rest arrives later", async () => {
    fixture = await commandFixture([NOT_PAIRED, AUTH_OK])

    const { code, stdout } = await fixture.run(runPair, ["--full-history", "--history-days", "30"])

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain("The phone keeps sending older history for a while;")
    expect(stdout.indexOf("Paired")).toBeLessThan(stdout.indexOf("older history"))
    const [call] = (await fixture.fake.calls()).filter((c) => c.argv.includes("auth"))
    expect(call!.argv).toEqual([
      "--store",
      fixture.paths("default").store,
      "--json",
      "auth",
      "--events",
      "--full-history",
      "--history-days",
      "30",
    ])
  })

  test("does not mention older history without --full-history", async () => {
    fixture = await commandFixture([NOT_PAIRED, AUTH_OK])
    expect((await fixture.run(runPair)).stdout).not.toContain("older history")
  })

  test("says how many messages arrived in the singular, and nothing when wacli does not say", async () => {
    fixture = await commandFixture([
      NOT_PAIRED,
      { ...AUTH_OK, stdout: '{"success":true,"data":{"authenticated":true,"messages_stored":1}}\n' },
    ])
    expect((await fixture.run(runPair)).stdout).toContain("1 message arrived while pairing.")
    await fixture.cleanup()

    fixture = await commandFixture([
      NOT_PAIRED,
      { ...AUTH_OK, stdout: '{"success":true,"data":{"authenticated":true}}\n' },
    ])
    expect((await fixture.run(runPair)).stdout).not.toContain("arrived")
  })

  test("draws a renewed code once, and a repeated one not at all", async () => {
    fixture = await commandFixture([
      NOT_PAIRED,
      { ...AUTH_OK, stderrLines: [qr("first-code", 0), qr("first-code", 20), qr("second-code", 40)] },
    ])

    const { stdout } = await fixture.run(runPair)

    expect(stdout.split(SCAN_INSTRUCTION)).toHaveLength(2)
    expect(stdout.split(RENEWED_INSTRUCTION)).toHaveLength(2)
    expect(stdout).not.toMatch(REDRAW)
  })

  test("replaces the drawing in place on a terminal, under the instructions printed once", async () => {
    fixture = await commandFixture([
      NOT_PAIRED,
      { ...AUTH_OK, stderrLines: [qr("first-code", 0), qr("second-code", 20)] },
    ])

    const { code, stdout } = await fixture.run(runPair, [], { stdoutIsTTY: true })

    expect(code).toBe(EXIT_OK)
    const [first = "", rest = ""] = stdout.split(REDRAW)
    const drawing = first.slice(first.indexOf("\n\n") + 2)
    const lines = drawing.split("\n").length - 1
    expect(first.startsWith(SCAN_INSTRUCTION)).toBe(true)
    expect(lines).toBeGreaterThan(0)
    expect(stdout).toContain(`${drawing}\x1b[${lines}F\x1b[0J`)
    expect(rest.startsWith("\x1b[38;5;")).toBe(true)
    expect(stdout.split(SCAN_INSTRUCTION)).toHaveLength(2)
    expect(stdout).not.toContain(RENEWED_INSTRUCTION)
  })

  test("prints a code renewed after the pairing code below it, not over it", async () => {
    fixture = await commandFixture([NOT_PAIRED, { ...AUTH_OK, stderrLines: [...CODE_EVENTS, qr("second-code", 40)] }])

    const { stdout } = await fixture.run(runPair, [], { stdoutIsTTY: true })

    expect(stdout.indexOf(PAIR_CODE_STEPS)).toBeLessThan(stdout.indexOf(RENEWED_INSTRUCTION))
    expect(stdout).not.toMatch(REDRAW)
  })

  test("reports a failure on standard error as one line and exits 1, with no code or number in it", async () => {
    fixture = await commandFixture([NOT_PAIRED, authFailing(`pairing refused for ${PHONE}`)])

    const { code, stdout, stderr } = await fixture.run(runPair, ["--phone", PHONE])

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: wacli reported an error (pairing refused for <number>).\n`)
    expect(stdout).not.toContain("Paired")
    expect(stdout + stderr).not.toContain(PHONE_DIGITS)
    expect(stderr).not.toContain(QR_PAYLOAD)
  })

  test("says to pair again when the code timed out", async () => {
    fixture = await commandFixture([
      NOT_PAIRED,
      authFailing("QR code timed out; run `wacli auth` again to get a new code"),
    ])

    const { code, stderr } = await fixture.run(runPair)

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: No device was paired in time; pair again to get a new code.\n`)
  })

  test("refuses a label that is paired", async () => {
    fixture = await commandFixture([DOCTOR_OK, AUTH_OK])

    const { code, stderr } = await fixture.run(runPair)

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toContain("already paired")
    expect((await fixture.fake.calls()).some((call) => call.argv.includes("auth"))).toBe(false)
  })

  test("reports a cancellation", async () => {
    fixture = await commandFixture([NOT_PAIRED, AUTH_OK])

    const { code, stderr } = await fixture.run(runPair, [], { signal: AbortSignal.abort() })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: Pairing was cancelled.\n`)
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("a mistake in the command line is one line on standard error and exit 2", async () => {
    fixture = await commandFixture([NOT_PAIRED, AUTH_OK])
    const mistakes = [
      ["--account"],
      ["--account", "--phone"],
      ["--phone="],
      ["--account", "Bad Label"],
      ["--phone", "12345"],
      ["--phone", "not-a-number"],
      ["--bogus"],
      ["extra"],
      ["--read-only"],
      ["--history-days", "30"],
      ["--full-history=yes"],
      ["--full-history", "--history-days"],
      ["--full-history", "--history-days", "0"],
      ["--full-history", "--history-days", "36501"],
      ["--full-history", "--history-days", "1.5"],
      ["--full-history", "--history-days", "abc"],
      ["--full-history", "--history-days", "-3"],
    ]
    for (const args of mistakes) {
      const { code, stdout, stderr } = await fixture.run(runPair, args)
      expect(code).toBe(EXIT_USAGE)
      expect(stdout).toBe("")
      expect(stderr).toMatch(new RegExp(`^${PROJECT.cli}: [^\\n]+\\n$`))
      expect(stderr).not.toContain("12345")
    }
    expect(await fixture.fake.calls()).toEqual([])
    expect(existsSync(fixture.paths("default").dir)).toBe(false)
  })
})
