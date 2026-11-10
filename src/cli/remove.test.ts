import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureLabelDir, listLabels } from "../core/whatsapp/labels"
import type { ServiceHost } from "../core/whatsapp/service"
import { DOCTOR_OK } from "../core/whatsapp/sync.testing"
import { envelope, failure, type FakeResponse } from "../core/whatsapp/wacli.testing"
import { PROJECT } from "../project"
import { commandFixture, type CommandFixture } from "./command.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { runRemoveCommand } from "./remove"
import { SERVICE_ID, SERVICE_LAUNCHER } from "./service"

const LOGOUT_OK: FakeResponse = { args: ["auth", "logout"], stdout: envelope({ logged_out: true }) }
const LOGOUT_FAILS: FakeResponse = { args: ["auth", "logout"], stderr: failure("connect failed"), exit: 1 }

let fixture: CommandFixture

afterEach(async () => {
  await fixture.cleanup()
})

function fakeHost(home: string, overrides: Partial<ServiceHost> = {}): ServiceHost {
  return {
    platform: "darwin",
    home,
    uid: 501,
    env: { PATH: "/bin" },
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides,
  }
}

/** A fixture holding the label `work`, whose wacli answers `responses`. */
async function withWork(responses: FakeResponse[] = [DOCTOR_OK, LOGOUT_OK]) {
  fixture = await commandFixture(responses)
  await ensureLabelDir(fixture.stateDir, "work")
}

/** Runs `remove` for `work` without a terminal, with a host that accepts everything. */
function remove(args: string[], overrides: Partial<CommandIo> = {}) {
  return fixture.run(runRemoveCommand, args, { isTTY: false, serviceHost: fakeHost(fixture.stateDir), ...overrides })
}

describe("CLI remove", () => {
  test("requires --account", async () => {
    await withWork()
    const { code, stderr } = await remove([])
    expect(code).toBe(EXIT_USAGE)
    expect(stderr).toBe(`${PROJECT.cli}: Option --account is required.\n`)
  })

  test("refuses without --yes on a non-terminal", async () => {
    await withWork()

    const { code, stderr } = await remove(["--account", "work"])

    expect(code).toBe(EXIT_USAGE)
    expect(stderr).toBe(`${PROJECT.cli}: Removing an account without a terminal requires --yes.\n`)
    expect(await listLabels(fixture.stateDir)).toEqual(["work"])
  })

  test("asks for the label back on a terminal, then logs the device out and removes the label", async () => {
    await withWork()
    let asked = ""

    const { code, stdout, stderr } = await remove(["--account", "work"], {
      isTTY: true,
      readLine: async (prompt) => {
        asked = prompt
        return "work"
      },
    })

    expect(code).toBe(EXIT_OK)
    expect(asked).toBe('To confirm, please type the label name "work": ')
    expect(stdout).toContain('Removed "work".')
    expect(stdout).toContain("The device was logged out of WhatsApp.")
    expect(stdout).not.toContain("remove it on the phone")
    expect(stderr).toBe("")
    expect(await listLabels(fixture.stateDir)).toEqual([])
  })

  test("cancels on a mismatch and leaves everything untouched", async () => {
    await withWork()

    const { code, stdout, stderr } = await remove(["--account", "work"], { isTTY: true, readLine: async () => "wrong" })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: Removal cancelled.\n`)
    expect(stdout).not.toContain("Removed")
    expect(await listLabels(fixture.stateDir)).toEqual(["work"])
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("removes without asking when --yes is given", async () => {
    await withWork()

    const { code, stdout, stderr } = await remove(["--account", "work", "--yes"])

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain('Removed "work".')
    expect(stderr).toBe("")
    expect(await listLabels(fixture.stateDir)).toEqual([])
  })

  test("deletes the launcher script along with the label", async () => {
    await withWork()
    const launcherDir = join(fixture.stateDir, "Library", "Application Support", SERVICE_ID)
    await mkdir(launcherDir, { recursive: true })
    await writeFile(join(launcherDir, `${SERVICE_LAUNCHER}-work`), "x")

    const { code } = await remove(["--account", "work", "--yes"])

    expect(code).toBe(EXIT_OK)
    expect(existsSync(launcherDir)).toBe(false)
  })

  test("says to remove the device on the phone when it could not be logged out", async () => {
    await withWork([DOCTOR_OK, LOGOUT_FAILS])

    const { code, stdout, stderr } = await remove(["--account", "work", "--yes"])

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain('Removed "work".')
    expect(stdout).toContain("remove it on the phone: WhatsApp > Linked devices.")
    expect(stderr).toBe("")
    expect(existsSync(fixture.paths("work").dir)).toBe(false)
  })

  test("stops and deletes nothing when the service cannot be uninstalled", async () => {
    await withWork()
    const failingHost = fakeHost(fixture.stateDir, {
      run: async () => ({ code: 1, stdout: "", stderr: "launchctl bootout: Operation not permitted" }),
    })

    const { code, stderr } = await remove(["--account", "work", "--yes"], { serviceHost: failingHost })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toContain("launchctl failed: launchctl bootout: Operation not permitted")
    expect(await listLabels(fixture.stateDir)).toEqual(["work"])
    expect(await fixture.fake.calls()).toEqual([])
  })

  test("lets removal proceed when services are unsupported on the platform", async () => {
    await withWork()

    const { code, stdout, stderr } = await remove(["--account", "work", "--yes"], {
      serviceHost: fakeHost("C:\\Users\\test", { platform: "win32" }),
    })

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain('Removed "work".')
    expect(stderr).toBe("")
    expect(await listLabels(fixture.stateDir)).toEqual([])
  })

  test("reports an account that does not exist", async () => {
    await withWork()

    const { code, stderr } = await remove(["--account", "nobody", "--yes"])

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: WhatsApp account "nobody" was not found; known accounts: work.\n`)
  })

  test("reports a cancellation and deletes nothing", async () => {
    await withWork()

    const { code, stderr } = await remove(["--account", "work", "--yes"], { signal: AbortSignal.abort() })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(`${PROJECT.cli}: Removal was cancelled.\n`)
    expect(await listLabels(fixture.stateDir)).toEqual(["work"])
  })
})
