import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { ensureLabelDir } from "../core/whatsapp/labels"
import type { ServiceHost } from "../core/whatsapp/service"
import { readServiceRecord } from "../core/whatsapp/service-record"
import { DOCTOR_OK } from "../core/whatsapp/sync.testing"
import { PROJECT } from "../project"
import { commandFixture, type CommandFixture } from "./command.testing"
import { EXIT_OK } from "./command-io"
import { SERVICE_ID, runServiceCommand } from "./service"

const VERSION = "9.8.7"

let fixture: CommandFixture
let tools: string

function fakeHost(home: string, overrides: Partial<ServiceHost> = {}): ServiceHost {
  return {
    platform: "darwin",
    home,
    uid: 501,
    env: { PATH: "/bin" },
    sleep: async () => {},
    run: async (argv) =>
      argv[1] === "print"
        ? { code: 113, stdout: "", stderr: "Could not find service" }
        : { code: 0, stdout: "", stderr: "" },
    ...overrides,
  }
}

beforeEach(async () => {
  fixture = await commandFixture([DOCTOR_OK])
  tools = await mkdtemp(join(tmpdir(), "wa-tools-"))
  await ensureLabelDir(fixture.stateDir, "default")
})

afterEach(async () => {
  await fixture.cleanup()
  await rm(tools, { recursive: true, force: true })
})

/**
 * Runs the service command with `dirs` added to the end of the fake's `PATH`, which the fake wacli
 * needs first for its own `node`; the `node`s found there start other programs than the one installed.
 */
function run(argv: string[], overrides: Parameters<CommandFixture["run"]>[2] = {}, dirs: string[] = [], extra = {}) {
  const env = { ...fixture.fake.env, ...extra, PATH: [fixture.fake.env.PATH, ...dirs].join(delimiter) }
  return fixture.run(runServiceCommand, argv, { env, serviceHost: fakeHost(fixture.stateDir), ...overrides })
}

async function makeFile(path: string, body = "", mode = 0o644): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, body)
  await chmod(path, mode)
  return path
}

async function versionedProgram(): Promise<string> {
  const program = join(tools, "rt", VERSION, "bin", "node")
  return makeFile(program, `#!/bin/sh\necho ${program}\n`, 0o755)
}

async function plistText(): Promise<string> {
  return readFile(join(fixture.stateDir, "Library", "LaunchAgents", `${SERVICE_ID}.default.plist`), "utf8")
}

describe("CLI service record", () => {
  test("install writes the record with the program and script, mode 600", async () => {
    const script = await makeFile(join(tools, "cli.js"))
    const { code, stderr } = await run(["install"], { self: { program: "/bin/node", script } })

    expect(code).toBe(EXIT_OK)
    expect(stderr).toBe("")
    const paths = fixture.paths("default")
    expect(readServiceRecord(paths)).toEqual({ program: "/bin/node", script })
    expect((await stat(paths.serviceRecord)).mode & 0o777).toBe(0o600)
    expect(paths.serviceRecord).not.toBe(paths.serviceStatus)
  })

  test("install warns when the program path holds its version and no stable node exists", async () => {
    const program = await versionedProgram()
    const script = await makeFile(join(tools, "cli.js"))
    const { code, stdout, stderr } = await run(["install"], { self: { program, script, version: VERSION } })

    expect(code).toBe(EXIT_OK)
    expect(stdout).toContain("Install the service again after updating Node or this package, as it records both paths.")
    expect(stderr).toContain(`Warning: the service runs Node at a path that holds its version (${program});`)
    expect(readServiceRecord(fixture.paths("default"))?.program).toBe(program)
    expect(await plistText()).toContain(`<string>${program}</string>`)
  })

  test("install records a node at a path without the version when it starts the same program", async () => {
    const program = await versionedProgram()
    const script = await makeFile(join(tools, "cli.js"))
    const binDir = join(tools, "stable")
    await mkdir(binDir)
    const link = join(binDir, "node")
    await symlink(program, link)

    const { code, stderr } = await run(["install"], { self: { program, script, version: VERSION } }, [binDir])

    expect(code).toBe(EXIT_OK)
    expect(stderr).toBe("")
    expect(readServiceRecord(fixture.paths("default"))?.program).toBe(link)
    expect(await plistText()).toContain(`<string>${link}</string>`)
  })

  test("install passes over a node under the temporary or runtime directory", async () => {
    const program = await versionedProgram()
    const script = await makeFile(join(tools, "cli.js"))
    const runtime = join(tools, "runtime")
    const binDir = join(runtime, "session", "bin")
    await mkdir(binDir, { recursive: true })
    await symlink(program, join(binDir, "node"))

    for (const setting of ["XDG_RUNTIME_DIR", "TMPDIR"]) {
      const { code, stderr } = await run(["install"], { self: { program, script, version: VERSION } }, [binDir], {
        [setting]: runtime,
      })
      expect(code).toBe(EXIT_OK)
      expect(stderr).toContain("Warning: the service runs Node at a path that holds its version")
      expect(readServiceRecord(fixture.paths("default"))?.program).toBe(program)
    }
  })

  test("an install that fails leaves no record of the earlier program", async () => {
    const script = await makeFile(join(tools, "cli.js"))
    const self = { program: "/bin/node", script }
    await run(["install"], { self })
    expect(readServiceRecord(fixture.paths("default"))).not.toBeNull()

    const failing = fakeHost(fixture.stateDir, { run: async () => ({ code: 1, stdout: "", stderr: "boom" }) })
    const { code } = await run(["install"], { self, serviceHost: failing })

    expect(code).not.toBe(EXIT_OK)
    expect(readServiceRecord(fixture.paths("default"))).toBeNull()
  })

  test("install does not warn when the program path does not hold the version", async () => {
    const script = await makeFile(join(tools, "cli.js"))
    const { stderr } = await run(["install"], { self: { program: "/bin/node", script, version: VERSION } })

    expect(stderr).toBe("")
  })

  test("uninstall deletes the record", async () => {
    const script = await makeFile(join(tools, "cli.js"))
    await run(["install"], { self: { program: "/bin/node", script } })
    expect(readServiceRecord(fixture.paths("default"))).not.toBeNull()

    const { code } = await run(["uninstall"])

    expect(code).toBe(EXIT_OK)
    expect(await stat(fixture.paths("default").serviceRecord).catch(() => undefined)).toBeUndefined()
  })

  test("uninstall succeeds without a record", async () => {
    const { code, stdout } = await run(["uninstall"])

    expect(code).toBe(EXIT_OK)
    expect(stdout).toBe('Uninstalled sync service for "default".\n')
  })

  describe("status", () => {
    async function installWith(program: string, script: string): Promise<void> {
      await run(["install"], { self: { program, script } })
    }

    test("shows the program and script when both exist", async () => {
      const program = await makeFile(join(tools, "bin", "node"), "", 0o755)
      const script = await makeFile(join(tools, "cli.js"))
      await installWith(program, script)

      const { code, stdout } = await run(["status"])

      expect(code).toBe(EXIT_OK)
      expect(stdout).toContain(`  Program: ${program}\n`)
      expect(stdout).toContain(`  Script: ${script}\n`)
      expect(stdout).not.toContain("Missing:")
      expect(stdout).not.toContain("gone")
    })

    test("names a missing program with the fix", async () => {
      const program = await makeFile(join(tools, "bin", "node"), "", 0o755)
      const script = await makeFile(join(tools, "cli.js"))
      await installWith(program, script)
      await rm(program)

      const { stdout } = await run(["status"])

      expect(stdout).toContain(`  Missing: ${program}\n`)
      expect(stdout).not.toContain(`  Missing: ${script}\n`)
      expect(stdout).toContain(
        `The program it was installed with is gone, as after updating Node or this package; install it again with: ${PROJECT.cli} service install --account default\n`,
      )
    })

    test("names a missing program and script", async () => {
      const program = await makeFile(join(tools, "bin", "node"), "", 0o755)
      const script = await makeFile(join(tools, "cli.js"))
      await installWith(program, script)
      await rm(program)
      await rm(script)

      const { stdout } = await run(["status"])

      expect(stdout).toContain(`  Missing: ${program}\n`)
      expect(stdout).toContain(`  Missing: ${script}\n`)
      expect(stdout).toContain(
        "The program and script it was installed with are gone, as after updating Node or this package;",
      )
    })

    test("prints none of these lines without a record", async () => {
      const { code, stdout } = await run(["status"])

      expect(code).toBe(EXIT_OK)
      expect(stdout).not.toContain("Program:")
      expect(stdout).not.toContain("Script:")
      expect(stdout).not.toContain("Missing:")
      expect(stdout).not.toContain("gone")
    })
  })
})
