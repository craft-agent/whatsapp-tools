import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecResult } from "../exec"
import {
  buildSystemdUnit,
  installSystemdService,
  quoteSystemdArg,
  systemdServiceStatus,
  uninstallSystemdService,
} from "./service-systemd"
import type { ServiceHost, ServiceSpec } from "./service-types"

function createFakeHost(
  home: string,
  overrides: Partial<ServiceHost> = {},
): {
  host: ServiceHost
  calls: string[][]
} {
  const calls: string[][] = []
  const customRun = overrides.run
  const host: ServiceHost = {
    platform: "linux",
    home,
    uid: 1000,
    env: { PATH: "/usr/bin:/bin", XDG_CONFIG_HOME: join(home, ".config") },
    ...overrides,
    run: async (argv: string[]): Promise<ExecResult> => {
      calls.push(argv)
      if (customRun) return customRun(argv)
      return { code: 0, stdout: "", stderr: "" }
    },
  }
  return { host, calls }
}

describe("service-systemd", () => {
  test("quoteSystemdArg escapes backslashes, double quotes, percent, and dollar signs", () => {
    expect(quoteSystemdArg('C:\\Path\\To "file" %u $VAR')).toBe('"C:\\\\Path\\\\To \\"file\\" %%u $$VAR"')
  })

  test("buildSystemdUnit formats unit file with quoted ExecStart and systemd sections", () => {
    const spec: ServiceSpec = {
      id: "io.github.craft-agent.whatsapp-tools",
      label: "personal",
      program: "/usr/local/bin/node",
      args: ["/opt/whatsapp-tools/cli.js", "sync", "--account", "personal", "$100", "%h"],
      path: "/usr/local/bin:/usr/bin",
      launcher: "example-sync",
    }

    const unit = buildSystemdUnit(spec)
    expect(unit).toContain("Description=WhatsApp sync service (personal)")
    expect(unit).toContain("Type=simple")
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/opt/whatsapp-tools/cli.js" "sync" "--account" "personal" "$$100" "%%h"',
    )
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin"')
    expect(unit).toContain("Restart=on-failure")
    expect(unit).toContain("RestartSec=60")
    expect(unit).toContain("WantedBy=default.target")
  })

  test("buildSystemdUnit escapes percent signs in Environment PATH so specifiers are not expanded", () => {
    const spec: ServiceSpec = {
      id: "io.github.craft-agent.whatsapp-tools",
      label: "personal",
      program: "/bin/node",
      args: ["cli.js"],
      path: "/usr/bin:/home/%u/bin:%h",
      launcher: "example-sync",
    }

    const unit = buildSystemdUnit(spec)
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/%%u/bin:%%h"')
  })

  test("refuses control characters in program, args, or PATH", async () => {
    const baseSpec: ServiceSpec = {
      id: "io.github.craft-agent.whatsapp-tools",
      label: "work",
      program: "/bin/node",
      args: ["sync"],
      path: "/bin",
      launcher: "example-sync",
    }

    expect(() => buildSystemdUnit({ ...baseSpec, program: "/bin/no\nde" })).toThrow(
      "Control characters are not allowed in the program.",
    )

    expect(() => buildSystemdUnit({ ...baseSpec, args: ["sync", "arg\x1fbad"] })).toThrow(
      "Control characters are not allowed in an argument.",
    )

    expect(() => buildSystemdUnit({ ...baseSpec, path: "/bin:\t/usr/bin" })).toThrow(
      "Control characters are not allowed in PATH.",
    )

    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const { host } = createFakeHost(dir)
      const error = await installSystemdService({ ...baseSpec, path: "/bin\0" }, host).catch((e: unknown) => e)
      expect((error as { code: string }).code).toBe("invalid_argument")
      expect((error as Error).message).toContain("PATH")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("installSystemdService writes unit file 0644 and runs daemon-reload and enable --now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const { host, calls } = createFakeHost(dir)
      const spec: ServiceSpec = {
        id: "io.github.craft-agent.whatsapp-tools",
        label: "default",
        program: "/bin/node",
        args: ["cli.js", "sync"],
        path: "/bin",
        launcher: "example-sync",
      }

      const result = await installSystemdService(spec, host)

      const expectedUnit = join(dir, ".config/systemd/user/io-github-craft-agent-whatsapp-tools-default.service")
      expect(result.file).toBe(expectedUnit)
      expect(result.log).toBe("journalctl --user -u io-github-craft-agent-whatsapp-tools-default.service")

      const fileStat = await stat(expectedUnit)
      expect(fileStat.mode & 0o777).toBe(0o644)

      expect(calls).toEqual([
        ["systemctl", "--user", "is-active", "io-github-craft-agent-whatsapp-tools-default.service"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "io-github-craft-agent-whatsapp-tools-default.service"],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("installSystemdService restarts unit if it was already active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const { host, calls } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[2] === "is-active") {
            return { code: 0, stdout: "active\n", stderr: "" }
          }
          return { code: 0, stdout: "", stderr: "" }
        },
      })
      const spec: ServiceSpec = {
        id: "io.github.craft-agent.whatsapp-tools",
        label: "default",
        program: "/bin/node",
        args: [],
        path: "/bin",
        launcher: "example-sync",
      }

      await installSystemdService(spec, host)

      expect(calls).toContainEqual([
        "systemctl",
        "--user",
        "restart",
        "io-github-craft-agent-whatsapp-tools-default.service",
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallSystemdService disables unit (ignoring not loaded), deletes file, and reloads daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const { host, calls } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[2] === "disable") {
            return { code: 1, stdout: "", stderr: "Failed to disable unit: Unit file not loaded." }
          }
          return { code: 0, stdout: "", stderr: "" }
        },
      })

      await uninstallSystemdService("io.github.craft-agent.whatsapp-tools", "default", host)

      expect(calls).toEqual([
        ["systemctl", "--user", "disable", "--now", "io-github-craft-agent-whatsapp-tools-default.service"],
        ["systemctl", "--user", "daemon-reload"],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("systemdServiceStatus parses ActiveState, MainPID, and ExecMainStatus", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const spec: ServiceSpec = {
        id: "io.github.craft-agent.whatsapp-tools",
        label: "default",
        program: "/bin/node",
        args: [],
        path: "/bin",
        launcher: "example-sync",
      }

      const { host: hostNotInstalled } = createFakeHost(dir)
      const notInstalled = await systemdServiceStatus(spec.id, spec.label, hostNotInstalled)
      expect(notInstalled.installed).toBe(false)
      expect(notInstalled.running).toBe(false)

      await installSystemdService(spec, hostNotInstalled)

      const { host: hostRunning } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[2] === "show") {
            return {
              code: 0,
              stdout: "ActiveState=active\nMainPID=9876\nExecMainStatus=0\n",
              stderr: "",
            }
          }
          return { code: 0, stdout: "", stderr: "" }
        },
      })

      const runningStatus = await systemdServiceStatus(spec.id, spec.label, hostRunning)
      expect(runningStatus.installed).toBe(true)
      expect(runningStatus.running).toBe(true)
      expect(runningStatus.pid).toBe(9876)
      expect(runningStatus.lastExit).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
