import { afterEach, describe, expect, test } from "bun:test"
import { ensureLabelDir } from "../core/whatsapp/labels"
import { DOCTOR_OK, HANGING_SYNC, LABEL, doctor, eventually } from "../core/whatsapp/sync.testing"
import { eventLine } from "../core/whatsapp/wacli.testing"
import { PROJECT } from "../project"
import { commandFixture, type CommandFixture } from "./command.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { runSyncCommand } from "./sync"

/** A log line: the local time with its offset, to the millisecond, then the message. */
const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \S/

let fixture: CommandFixture

afterEach(async () => {
  await fixture.cleanup()
})

/** A fixture whose state directory holds the labels `labels`. */
async function withLabels(responses: Parameters<typeof commandFixture>[0], ...labels: string[]) {
  fixture = await commandFixture(responses)
  for (const label of labels) await ensureLabelDir(fixture.stateDir, label)
}

describe("runSyncCommand", () => {
  test("runs the only account in the foreground, logs with the local time, and exits 0 on a stop request", async () => {
    await withLabels([DOCTOR_OK, HANGING_SYNC], LABEL)
    const controller = new AbortController()
    const { done, output } = fixture.start(runSyncCommand, [], { signal: controller.signal })

    await eventually(() => output().stderr.includes("running"))
    controller.abort()
    const code = await done

    const { stdout, stderr } = output()
    expect(code).toBe(EXIT_OK)
    expect(stdout).toBe("")
    const lines = stderr.split("\n").slice(0, -1)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) expect(line).toMatch(LOG_LINE)
    expect(lines.map((line) => line.slice(30))).toContain("event connected")
    expect(lines.at(-1)).toEndWith(" stopped")
  })

  test("takes the account by name, with another account around", async () => {
    await withLabels([DOCTOR_OK, HANGING_SYNC], LABEL, "other")
    const controller = new AbortController()
    const { done, output } = fixture.start(runSyncCommand, ["--account=main"], { signal: controller.signal })

    await eventually(() => output().stderr.includes("running"))
    controller.abort()

    expect(await done).toBe(EXIT_OK)
    const [call] = (await fixture.fake.calls()).filter((c) => c.argv.includes("sync"))
    expect(call!.argv).toContain(fixture.paths().store)
  })

  test("exits 1 when the sync service fails", async () => {
    await withLabels([DOCTOR_OK, { args: ["sync"], stderrLines: [{ line: eventLine("connected") }], exit: 1 }], LABEL)

    const { code, stderr } = await fixture.run(runSyncCommand)

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toContain("sync ended: wacli exited (code 1)")
  })

  test("exits 0 when WhatsApp revoked the session", async () => {
    await withLabels([DOCTOR_OK, { args: ["sync"], stderrLines: [{ line: eventLine("logged_out") }], exit: 0 }], LABEL)

    const { code, stderr } = await fixture.run(runSyncCommand)

    expect(code).toBe(EXIT_OK)
    expect(stderr).toContain("staying down")
  })

  test("exits 0 for a label that has no paired device", async () => {
    await withLabels([doctor({ authenticated: false, session_revoked: false }), HANGING_SYNC], LABEL)

    const { code, stderr } = await fixture.run(runSyncCommand)

    expect(code).toBe(EXIT_OK)
    expect(stderr).toContain("no WhatsApp device is paired")
    expect((await fixture.fake.calls()).some((call) => call.argv.includes("sync"))).toBe(false)
  })

  test("several accounts need a name: usage error listing them", async () => {
    await withLabels([DOCTOR_OK, HANGING_SYNC], LABEL, "other")

    const { code, stdout, stderr } = await fixture.run(runSyncCommand)

    expect(code).toBe(EXIT_USAGE)
    expect(stdout).toBe("")
    expect(stderr).toBe(
      `${PROJECT.cli}: Several WhatsApp accounts are paired; name one with \`account\`: main, other.\n`,
    )
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("an account that does not exist, or no account at all, is not paired: exit 0", async () => {
    await withLabels([DOCTOR_OK, HANGING_SYNC], LABEL)
    const unknown = await fixture.run(runSyncCommand, ["--account", "nobody"])
    expect(unknown.code).toBe(EXIT_OK)
    expect(unknown.stderr).toMatch(/ no WhatsApp account is paired; pair a device first\n$/)
    expect(await fixture.fake.calls()).toEqual([])

    await fixture.cleanup()
    await withLabels([DOCTOR_OK, HANGING_SYNC])
    const none = await fixture.run(runSyncCommand)
    expect(none.code).toBe(EXIT_OK)
    expect(none.stderr).toMatch(/ no WhatsApp account is paired; pair a device first\n$/)
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("a malformed account name is a usage error", async () => {
    await withLabels([DOCTOR_OK, HANGING_SYNC], LABEL)

    const { code, stderr } = await fixture.run(runSyncCommand, ["--account", "Nobody"])

    expect(code).toBe(EXIT_USAGE)
    expect(stderr).toStartWith(`${PROJECT.cli}: Invalid label`)
  })

  test("an aborted signal stops before anything starts", async () => {
    await withLabels([DOCTOR_OK, HANGING_SYNC], LABEL)

    const { code } = await fixture.run(runSyncCommand, [], { signal: AbortSignal.abort() })

    expect(code).toBe(EXIT_OK)
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("a mistake in the command line is one line on standard error and exit 2", async () => {
    await withLabels([DOCTOR_OK, HANGING_SYNC], LABEL)
    const mistakes = [["--account"], ["--account", "--state-dir"], ["--account="], ["--account", "Bad Label"]]
    mistakes.push(["--bogus"], ["extra"], ["--read-only"], ["--verbose"])
    for (const args of mistakes) {
      const { code, stdout, stderr } = await fixture.run(runSyncCommand, args)
      expect(code).toBe(EXIT_USAGE)
      expect(stdout).toBe("")
      expect(stderr).toMatch(new RegExp(`^${PROJECT.cli}: [^\\n]+\\n$`))
    }
    expect(await fixture.fake.calls()).toEqual([])
  })
})
