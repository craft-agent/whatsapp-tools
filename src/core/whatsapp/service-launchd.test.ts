import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ExecResult } from "../exec"
import {
  buildLaunchdPlist,
  LAUNCHER_SCRIPT,
  installLaunchdService,
  launchdServiceStatus,
  uninstallLaunchdService,
  xmlEscape,
} from "./service-launchd"
import type { ServiceHost, ServiceSpec } from "./service-types"

const LAUNCHER = "example-sync"
const NOT_FOUND: ExecResult = { code: 113, stdout: "", stderr: "Could not find service" }
const FOUND: ExecResult = { code: 0, stdout: "state = running\n", stderr: "" }

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
    platform: "darwin",
    home,
    uid: 501,
    env: { PATH: "/usr/bin:/bin" },
    sleep: async () => {},
    ...overrides,
    run: async (argv: string[]): Promise<ExecResult> => {
      calls.push(argv)
      if (customRun) return customRun(argv)
      if (argv[1] === "print") return NOT_FOUND
      return { code: 0, stdout: "", stderr: "" }
    },
  }
  return { host, calls }
}

describe("service-launchd", () => {
  test("xmlEscape escapes special characters", () => {
    expect(xmlEscape("a & b < c > d \"e\" 'f'")).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;")
  })

  test("buildLaunchdPlist generates valid plist XML with required keys and escaped strings", () => {
    const spec: ServiceSpec = {
      id: "io.github.craft-agent.whatsapp-tools",
      label: "work",
      program: "/path/to/node",
      args: ["/path/to/cli.js", "sync", "--account", "work <test>", "--state-dir", "/state & dir"],
      path: "/usr/local/bin:/usr/bin",
      launcher: LAUNCHER,
    }
    const logPath = "/Users/test/Library/Logs/io.github.craft-agent.whatsapp-tools/work.log"
    const launcherPath =
      "/Users/test/Library/Application Support/io.github.craft-agent.whatsapp-tools/example-sync-work"
    const xml = buildLaunchdPlist(spec, logPath, launcherPath)

    expect(xml).toContain(
      `<key>ProgramArguments</key>\n\t<array>\n\t\t<string>${launcherPath}</string>\n\t\t<string>/path/to/node</string>\n\t\t<string>/path/to/cli.js</string>\n\t\t<string>sync</string>`,
    )
    expect(xml).toContain("<key>Label</key>\n\t<string>io.github.craft-agent.whatsapp-tools.work</string>")
    expect(xml).toContain("<string>/path/to/node</string>")
    expect(xml).toContain("<string>work &lt;test&gt;</string>")
    expect(xml).toContain("<string>/state &amp; dir</string>")
    expect(xml).toContain("<key>PATH</key>\n\t\t<string>/usr/local/bin:/usr/bin</string>")
    expect(xml).toContain("<key>RunAtLoad</key>\n\t<true/>")
    expect(xml).toContain("<key>SuccessfulExit</key>\n\t\t<false/>")
    expect(xml).toContain("<key>ThrottleInterval</key>\n\t<integer>60</integer>")
    expect(xml).toContain("<key>ProcessType</key>\n\t<string>Background</string>")
    expect(xml).toContain(`<key>StandardOutPath</key>\n\t<string>${logPath}</string>`)
    expect(xml).toContain(`<key>StandardErrorPath</key>\n\t<string>${logPath}</string>`)
  })

  test("refuses control characters in program, args, or PATH", async () => {
    const baseSpec: ServiceSpec = {
      id: "io.github.craft-agent.whatsapp-tools",
      label: "work",
      program: "/bin/node",
      args: ["sync"],
      path: "/bin",
      launcher: LAUNCHER,
    }
    const logPath = "/tmp/test.log"
    const launcherPath = "/tmp/example-sync-work"

    expect(() => buildLaunchdPlist({ ...baseSpec, program: "/bin/no\nde" }, logPath, launcherPath)).toThrow(
      "Control characters are not allowed in the program.",
    )

    expect(() => buildLaunchdPlist({ ...baseSpec, args: ["sync", "arg\x00bad"] }, logPath, launcherPath)).toThrow(
      "Control characters are not allowed in an argument.",
    )

    expect(() => buildLaunchdPlist({ ...baseSpec, path: "/bin:\r/usr/bin" }, logPath, launcherPath)).toThrow(
      "Control characters are not allowed in PATH.",
    )

    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const { host } = createFakeHost(dir)
      const error = await installLaunchdService({ ...baseSpec, program: "/bin/no\x7fde" }, host).catch(
        (e: unknown) => e,
      )
      expect((error as { code: string }).code).toBe("invalid_argument")
      expect((error as Error).message).toContain("the program")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("installLaunchdService creates directories with proper modes, writes plist 0644, and runs launchctl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const { host, calls } = createFakeHost(dir)
      const spec: ServiceSpec = {
        id: "io.github.craft-agent.whatsapp-tools",
        label: "default",
        program: "/bin/node",
        args: ["cli.js", "sync"],
        path: "/bin",
        launcher: LAUNCHER,
      }

      const result = await installLaunchdService(spec, host)

      const expectedPlist = join(dir, "Library/LaunchAgents/io.github.craft-agent.whatsapp-tools.default.plist")
      const expectedLogDir = join(dir, "Library/Logs/io.github.craft-agent.whatsapp-tools")
      expect(result.file).toBe(expectedPlist)

      const plistStat = await stat(expectedPlist)
      expect(plistStat.mode & 0o777).toBe(0o644)

      const logDirStat = await stat(expectedLogDir)
      expect(logDirStat.mode & 0o777).toBe(0o700)

      expect(calls).toEqual([
        ["launchctl", "bootout", "gui/501/io.github.craft-agent.whatsapp-tools.default"],
        ["launchctl", "print", "gui/501/io.github.craft-agent.whatsapp-tools.default"],
        ["launchctl", "bootstrap", "gui/501", expectedPlist],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe("launcher script", () => {
    const spec: ServiceSpec = {
      id: "io.github.craft-agent.whatsapp-tools",
      label: "default",
      program: "/bin/node",
      args: ["cli.js", "sync"],
      path: "/bin",
      launcher: LAUNCHER,
    }
    const launcherRelative = `Library/Application Support/${spec.id}/${spec.launcher}-${spec.label}`

    test("installLaunchdService writes an executable launcher and lists it first in the plist", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host } = createFakeHost(dir)
        const result = await installLaunchdService(spec, host)

        const launcherPath = join(dir, launcherRelative)
        expect(await readFile(launcherPath, "utf8")).toBe(LAUNCHER_SCRIPT)
        expect((await stat(launcherPath)).mode & 0o777).toBe(0o755)
        expect((await stat(dirname(launcherPath))).mode & 0o777).toBe(0o700)

        const plist = await readFile(result.file, "utf8")
        expect(plist).toContain(
          `<array>\n\t\t<string>${launcherPath}</string>\n\t\t<string>/bin/node</string>\n\t\t<string>cli.js</string>`,
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("installing again replaces the existing launcher", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host } = createFakeHost(dir)
        await installLaunchdService(spec, host)
        await installLaunchdService(spec, host)

        expect(await readFile(join(dir, launcherRelative), "utf8")).toBe(LAUNCHER_SCRIPT)
        expect(await readdir(dirname(join(dir, launcherRelative)))).toEqual([`${spec.launcher}-${spec.label}`])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("a symlink at the launcher path is replaced, never followed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host } = createFakeHost(dir)
        const launcherPath = join(dir, launcherRelative)
        const target = join(dir, "target.txt")
        await writeFile(target, "keep me")
        await mkdir(dirname(launcherPath), { recursive: true })
        await symlink(target, launcherPath)

        await installLaunchdService(spec, host)

        expect(await readFile(target, "utf8")).toBe("keep me")
        expect((await lstat(launcherPath)).isFile()).toBe(true)
        expect(await readFile(launcherPath, "utf8")).toBe(LAUNCHER_SCRIPT)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    const name = { id: spec.id, launcher: spec.launcher }

    test("uninstalling deletes the launcher and its directory", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host } = createFakeHost(dir)
        await installLaunchdService(spec, host)
        const launcherPath = join(dir, launcherRelative)

        await uninstallLaunchdService(name, spec.label, host)

        await expect(lstat(launcherPath)).rejects.toThrow()
        await expect(lstat(dirname(launcherPath))).rejects.toThrow()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("uninstalling one label keeps the launcher of another", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host } = createFakeHost(dir)
        await installLaunchdService(spec, host)
        await installLaunchdService({ ...spec, label: "work" }, host)
        const launcherPath = join(dir, launcherRelative)
        const workPath = join(dirname(launcherPath), `${spec.launcher}-work`)

        await uninstallLaunchdService(name, spec.label, host)

        await expect(lstat(launcherPath)).rejects.toThrow()
        expect(await readFile(workPath, "utf8")).toBe(LAUNCHER_SCRIPT)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("a symlink at the launcher path is not followed when uninstalling", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host } = createFakeHost(dir)
        const launcherPath = join(dir, launcherRelative)
        const target = join(dir, "target.txt")
        await writeFile(target, "keep me")
        await mkdir(dirname(launcherPath), { recursive: true })
        await symlink(target, launcherPath)

        await uninstallLaunchdService(name, spec.label, host)

        expect(await readFile(target, "utf8")).toBe("keep me")
        expect((await lstat(launcherPath)).isSymbolicLink()).toBe(true)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("an invalid launcher name is refused only after the agent is unloaded", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host, calls } = createFakeHost(dir)
        const { file } = await installLaunchdService(spec, host)

        const error = await uninstallLaunchdService({ ...name, launcher: "../x" }, spec.label, host).catch(
          (e: unknown) => e,
        )

        expect((error as { code: string }).code).toBe("invalid_argument")
        expect(calls.at(-2)).toEqual(["launchctl", "bootout", `gui/501/${spec.id}.${spec.label}`])
        expect(calls.at(-1)).toEqual(["launchctl", "print", `gui/501/${spec.id}.${spec.label}`])
        await expect(lstat(file)).rejects.toThrow()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("refuses an invalid launcher name and writes nothing", async () => {
      for (const launcher of ["", "../x", "a/b", ".hidden"]) {
        const dir = await mkdtemp(join(tmpdir(), "wa-"))
        try {
          const { host, calls } = createFakeHost(dir)
          const error = await installLaunchdService({ ...spec, launcher }, host).catch((e: unknown) => e)

          expect((error as { code: string }).code).toBe("invalid_argument")
          expect(await readdir(dir)).toEqual([])
          expect(calls).toEqual([])
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }
    })
  })

  test("installLaunchdService ignores 'not loaded' during bootout but maps bootstrap failure to upstream_error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const { host } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[1] === "bootout") {
            return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" }
          }
          if (argv[1] === "bootstrap") {
            return { code: 1, stdout: "", stderr: "Bootstrap failed for +1234567890 permission denied" }
          }
          if (argv[1] === "print") return NOT_FOUND
          return { code: 0, stdout: "", stderr: "" }
        },
      })
      const spec: ServiceSpec = {
        id: "io.github.craft-agent.whatsapp-tools",
        label: "default",
        program: "/bin/node",
        args: [],
        path: "/bin",
        launcher: LAUNCHER,
      }

      const error = await installLaunchdService(spec, host).catch((e: unknown) => e)
      expect((error as { code: string }).code).toBe("upstream_error")
      expect((error as Error).message).toBe("launchctl failed: Bootstrap failed for <number> permission denied")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallLaunchdService unloads and deletes plist; not installed is fine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const { host, calls } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[1] === "bootout") {
            return { code: 1, stdout: "", stderr: "service is not loaded" }
          }
          if (argv[1] === "print") return NOT_FOUND
          return { code: 0, stdout: "", stderr: "" }
        },
      })

      await uninstallLaunchdService({ id: "io.github.craft-agent.whatsapp-tools", launcher: LAUNCHER }, "default", host)
      expect(calls[0]).toEqual(["launchctl", "bootout", "gui/501/io.github.craft-agent.whatsapp-tools.default"])
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe("waiting for launchd to let go of the job", () => {
    const spec: ServiceSpec = {
      id: "io.github.craft-agent.whatsapp-tools",
      label: "default",
      program: "/bin/node",
      args: [],
      path: "/bin",
      launcher: LAUNCHER,
    }
    const name = { id: spec.id, launcher: spec.launcher }
    const plistRelative = `Library/LaunchAgents/${spec.id}.${spec.label}.plist`
    const maxPolls = 150

    /** A host whose `print` finds the job for the first `found` polls, or always when `found` is Infinity. */
    function lingeringHost(dir: string, found: number, onPrint: () => void = () => {}) {
      const sleeps: number[] = []
      let prints = 0
      const fake = createFakeHost(dir, {
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        run: async (argv) => {
          if (argv[1] !== "print") return { code: 0, stdout: "", stderr: "" }
          prints++
          onPrint()
          return prints <= found ? FOUND : NOT_FOUND
        },
      })
      return { ...fake, sleeps, prints: () => prints }
    }

    test("install bootstraps only once the job is gone", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host, calls, sleeps } = lingeringHost(dir, 2)

        await installLaunchdService(spec, host)

        expect(calls.map((argv) => argv[1])).toEqual(["bootout", "print", "print", "print", "bootstrap"])
        expect(sleeps).toEqual([200, 200])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("install gives up when the job never goes", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        const { host, calls, prints } = lingeringHost(dir, Infinity)

        const error = await installLaunchdService(spec, host).catch((e: unknown) => e)

        expect((error as { code: string }).code).toBe("upstream_error")
        expect((error as Error).message).toContain("30 seconds")
        expect(calls.some((argv) => argv[1] === "bootstrap")).toBe(false)
        expect(prints()).toBe(maxPolls)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("uninstall deletes the plist only once the job is gone", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        await installLaunchdService(spec, createFakeHost(dir).host)
        const plist = join(dir, plistRelative)
        const plistPresentAtPrint: boolean[] = []
        const { host } = lingeringHost(dir, 2, () => {
          plistPresentAtPrint.push(existsSync(plist))
        })

        await uninstallLaunchdService(name, spec.label, host)

        expect(plistPresentAtPrint).toEqual([true, true, true])
        expect(existsSync(plist)).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("uninstall that times out leaves the plist and launcher in place", async () => {
      const dir = await mkdtemp(join(tmpdir(), "wa-"))
      try {
        await installLaunchdService(spec, createFakeHost(dir).host)
        const { host } = lingeringHost(dir, Infinity)

        const error = await uninstallLaunchdService(name, spec.label, host).catch((e: unknown) => e)

        expect((error as { code: string }).code).toBe("upstream_error")
        expect(existsSync(join(dir, plistRelative))).toBe(true)
        expect(existsSync(join(dir, `Library/Application Support/${spec.id}/${spec.launcher}-${spec.label}`))).toBe(
          true,
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  test("launchdServiceStatus parses state, pid, and last exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-"))
    try {
      const spec: ServiceSpec = {
        id: "io.github.craft-agent.whatsapp-tools",
        label: "default",
        program: "/bin/node",
        args: [],
        path: "/bin",
        launcher: LAUNCHER,
      }

      const { host: host1 } = createFakeHost(dir)
      const notInstalled = await launchdServiceStatus(spec.id, spec.label, host1)
      expect(notInstalled.installed).toBe(false)
      expect(notInstalled.running).toBe(false)

      await installLaunchdService(spec, host1)

      const { host: hostRunning } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[1] === "print") {
            return {
              code: 0,
              stdout: "state = running\npid = 4321\nlast exit code = 0\n",
              stderr: "",
            }
          }
          return { code: 0, stdout: "", stderr: "" }
        },
      })
      const runningStatus = await launchdServiceStatus(spec.id, spec.label, hostRunning)
      expect(runningStatus.installed).toBe(true)
      expect(runningStatus.running).toBe(true)
      expect(runningStatus.pid).toBe(4321)
      expect(runningStatus.lastExit).toBe(0)

      const { host: hostStopped } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[1] === "print") {
            return {
              code: 0,
              stdout: "state = waiting\nlast exit code = 1\n",
              stderr: "",
            }
          }
          return { code: 0, stdout: "", stderr: "" }
        },
      })
      const stoppedStatus = await launchdServiceStatus(spec.id, spec.label, hostStopped)
      expect(stoppedStatus.installed).toBe(true)
      expect(stoppedStatus.running).toBe(false)
      expect(stoppedStatus.pid).toBeUndefined()
      expect(stoppedStatus.lastExit).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
