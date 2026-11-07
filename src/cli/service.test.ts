import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ensureLabelDir } from "../core/whatsapp/labels"
import type { ServiceHost } from "../core/whatsapp/service"
import { DOCTOR_OK, doctor } from "../core/whatsapp/sync.testing"
import { PROJECT } from "../project"
import { commandFixture, type CommandFixture } from "./command.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { SERVICE_ID, runServiceCommand } from "./service"

const SELF = { program: "/bin/node", script: "/bin/cli.js" }

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

/** A fixture whose state directory holds the labels `labels`, and whose wacli answers `responses`. */
async function withLabels(responses: Parameters<typeof commandFixture>[0], ...labels: string[]) {
  fixture = await commandFixture(responses)
  for (const label of labels) await ensureLabelDir(fixture.stateDir, label)
}

describe("CLI service install", () => {
  test("picks the only paired label when --account is absent, and runs this command line's sync for it", async () => {
    await withLabels([DOCTOR_OK], "default")

    const { code, stdout, stderr } = await fixture.run(runServiceCommand, ["install"], {
      serviceHost: fakeHost(fixture.stateDir),
      self: SELF,
    })

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain('Installed sync service for "default"')
    expect(stderr).toBe("")
    const file = /\((\S+)\)/.exec(stdout)![1]!
    const definition = readFileSync(file, "utf8")
    for (const argument of ["/bin/cli.js", "sync", "--account", "default", "--state-dir", fixture.stateDir]) {
      expect(definition).toContain(`<string>${argument}</string>`)
    }
    expect(definition).toContain(`${SERVICE_ID}.default`)
  })

  test("fails with usage listing accounts when --account is absent and several exist", async () => {
    await withLabels([DOCTOR_OK], "first", "second")

    const { code, stdout, stderr } = await fixture.run(runServiceCommand, ["install"], {
      serviceHost: fakeHost(fixture.stateDir),
    })

    expect(code).toBe(EXIT_USAGE)
    expect(stderr).toContain("Several WhatsApp accounts are paired; name one with --account: first, second.")
    expect(stdout).toBe("")
  })

  test("fails when --account is absent and no accounts are paired", async () => {
    await withLabels([DOCTOR_OK])

    const { code, stderr } = await fixture.run(runServiceCommand, ["install"], {
      serviceHost: fakeHost(fixture.stateDir),
    })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toContain("No WhatsApp account is paired yet; pair a device first.")
  })

  test.each([
    ["not paired", doctor({ authenticated: false, session_revoked: false })],
    ["revoked", doctor({ authenticated: false, session_revoked: true })],
  ])("refuses install when the label is %s", async (_name, answer) => {
    await withLabels([answer], "work")
    const host = fakeHost(fixture.stateDir)

    const { code, stderr } = await fixture.run(runServiceCommand, ["install", "--account", "work"], {
      serviceHost: host,
      self: SELF,
    })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(
      `${PROJECT.cli}: This label has no usable pairing; pair it first with: ${PROJECT.cli} pair --account work\n`,
    )
  })

  test("appends the tracking issue on Windows", async () => {
    await withLabels([DOCTOR_OK], "default")

    const { code, stderr } = await fixture.run(runServiceCommand, ["install"], {
      serviceHost: fakeHost(fixture.stateDir, { platform: "win32" }),
    })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toBe(
      `${PROJECT.cli}: Registering the sync service is not supported on Windows yet; run the sync command in a terminal instead. Windows support is tracked in https://github.com/craft-agent/whatsapp-tools/issues/11.\n`,
    )
  })

  test("prints required install information on Linux", async () => {
    await withLabels([DOCTOR_OK], "default")
    const host = fakeHost(fixture.stateDir, {
      platform: "linux",
      env: { PATH: "/bin", XDG_CONFIG_HOME: join(fixture.stateDir, ".config") },
    })

    const { code, stdout } = await fixture.run(runServiceCommand, ["install"], { serviceHost: host, self: SELF })

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain('Installed sync service for "default"')
    expect(stdout).toContain(
      "View logs with: journalctl --user -u io-github-craft-agent-whatsapp-tools-default.service",
    )
    expect(stdout).toContain("The service starts automatically at logon and restarts after a failure.")
    expect(stdout).toContain("Install the service again after updating this package, as it records the package path.")
    expect(stdout).toContain('Run "loginctl enable-linger" to keep the service running while logged out.')
  })
})

describe("CLI service status and uninstall", () => {
  test("status and uninstall output format", async () => {
    await withLabels([DOCTOR_OK], "default")
    const host = fakeHost(fixture.stateDir, {
      run: async (argv) =>
        argv[1] === "print"
          ? { code: 0, stdout: "state = running\npid = 1234\nlast exit code = 0\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    })

    await fixture.run(runServiceCommand, ["install"], { serviceHost: host, self: SELF })
    const status = await fixture.run(runServiceCommand, ["status"], { serviceHost: host })

    expect(status.code).toBe(EXIT_OK)
    for (const line of ["Installed: yes", "Running: yes", "PID: 1234", "Last exit: 0", "Log:"]) {
      expect(status.stdout).toContain(line)
    }

    const uninstall = await fixture.run(runServiceCommand, ["uninstall"], { serviceHost: host })
    expect(uninstall.code).toBe(EXIT_OK)
    expect(uninstall.stdout).toBe('Uninstalled sync service for "default".\n')
  })

  test("uninstalling and asking for the status need no wacli", async () => {
    await withLabels([], "default")
    const host = fakeHost(fixture.stateDir)

    await fixture.run(runServiceCommand, ["status"], { serviceHost: host })
    await fixture.run(runServiceCommand, ["uninstall"], { serviceHost: host })

    expect(await fixture.fake.calls()).toEqual([])
  })

  test("names the label without the directory existing, so an orphaned service can be removed", async () => {
    await withLabels([])

    const { code, stdout } = await fixture.run(runServiceCommand, ["uninstall", "--account", "gone"], {
      serviceHost: fakeHost(fixture.stateDir),
    })

    expect(code).toBe(EXIT_OK)
    expect(stdout).toBe('Uninstalled sync service for "gone".\n')
  })

  test("refuses on Windows with the core refusal and exit 1", async () => {
    await withLabels([], "default")

    const { code, stderr } = await fixture.run(runServiceCommand, ["status"], {
      serviceHost: fakeHost(fixture.stateDir, { platform: "win32" }),
    })

    expect(code).toBe(EXIT_FAILED)
    expect(stderr).toContain("Registering the sync service is not supported on Windows yet")
  })
})

describe("CLI service usage", () => {
  test("a mistake in the command line is one line on standard error and exit 2", async () => {
    await withLabels([DOCTOR_OK], "default")
    const mistakes = [
      [],
      ["bogus"],
      ["install", "--account"],
      ["install", "--account", "Bad Label"],
      ["install", "--bogus"],
      ["status", "extra"],
    ]
    for (const args of mistakes) {
      const { code, stdout, stderr } = await fixture.run(runServiceCommand, args, {
        serviceHost: fakeHost(fixture.stateDir),
      })
      expect(code).toBe(EXIT_USAGE)
      expect(stdout).toBe("")
      expect(stderr).toMatch(new RegExp(`^${PROJECT.cli}: [^\\n]+\\n$`))
    }
  })
})
