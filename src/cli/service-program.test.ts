import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathHoldsVersion, pickStableProgram } from "./service-program"

const VERSION = "9.8.7"

describe("pathHoldsVersion", () => {
  test.each([
    ["/opt/9.8.7/bin/node", true],
    ["/opt/node-v9.8.7-os-arch/bin/node", true],
    ["/opt/v9.8.7/bin/node", true],
    ["/opt/other/9.8.6/bin/9.8.7", true],
    ["/opt/19.8.7/bin/node", false],
    ["/opt/9.8.71/bin/node", false],
    ["/opt/9.8.7.1/bin/node", false],
    ["/opt/9.8.7.tar/node", false],
    ["/usr/bin/node", false],
  ])("%s -> %p", (path, expected) => {
    expect(pathHoldsVersion(path, VERSION)).toBe(expected)
  })

  test("an empty version is never held", () => {
    expect(pathHoldsVersion("/usr/bin/node", "")).toBe(false)
  })
})

describe("pickStableProgram", () => {
  let root: string
  let program: string
  let other: string
  let cwd: string

  async function script(path: string, body: string, mode = 0o755): Promise<string> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, mode)
    return path
  }

  const printing = (path: string) => `echo '${path}'`
  const pick = (path: string, options: Partial<Parameters<typeof pickStableProgram>[0]> = {}) =>
    pickStableProgram({ program, version: VERSION, path, home: root, cwd, ...options })

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "service-program-")))
    cwd = root
    program = await script(join(root, "runtimes", VERSION, "bin", "node"), "exit 0")
    other = await script(join(root, "runtimes", "9.8.6", "bin", "node"), "exit 0")
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("a program without the version is kept and never probed", async () => {
    const kept = join(root, "plain", "node")
    let probed = 0
    const result = await pickStableProgram({
      program: kept,
      version: VERSION,
      path: join(root, "stable"),
      home: root,
      cwd,
      probe: async () => {
        probed += 1
        return undefined
      },
    })
    expect(result).toEqual({ program: kept, versioned: false })
    expect(probed).toBe(0)
  })

  test("a link to the program on the PATH is chosen, run for real", async () => {
    await script(program, printing(program))
    const dir = join(root, "linked")
    await mkdir(dir)
    await symlink(program, join(dir, "node"))
    expect(await pick(dir)).toEqual({ program: join(dir, "node"), versioned: false })
  })

  test("a shim that starts the same program is chosen", async () => {
    await script(program, printing(program))
    const shim = await script(join(root, "shim", "node"), printing(program))
    expect(await pick(join(root, "shim"))).toEqual({ program: shim, versioned: false })
  })

  test("a shim that starts another program is skipped for the next entry", async () => {
    await script(program, printing(program))
    await script(join(root, "wrong", "node"), printing(other))
    const right = await script(join(root, "right", "node"), printing(program))
    expect(await pick(`${join(root, "wrong")}:${join(root, "right")}`)).toEqual({ program: right, versioned: false })
  })

  test("without a match the program stays and is reported as versioned", async () => {
    await script(join(root, "wrong", "node"), printing(other))
    expect(await pick(join(root, "wrong"))).toEqual({ program, versioned: true })
    expect(await pick("")).toEqual({ program, versioned: true })
  })

  test("a candidate whose own path holds the version is skipped without probing", async () => {
    const dir = join(root, "holds", VERSION, "bin")
    await script(join(dir, "node"), printing(program))
    const probed: string[] = []
    const result = await pick(dir, {
      probe: async (candidate) => {
        probed.push(candidate)
        return program
      },
    })
    expect(result).toEqual({ program, versioned: true })
    expect(probed).toEqual([])
  })

  test("a candidate under a volatile root, named or linked, is skipped without probing", async () => {
    const volatile = join(root, "volatile")
    const session = join(volatile, "session-1", "bin")
    await mkdir(session, { recursive: true })
    await symlink(program, join(session, "node"))
    const lasting = join(root, "lasting")
    await mkdir(lasting, { recursive: true })
    await symlink(program, join(lasting, "node"))
    const linkedRoot = join(root, "volatile-link")
    await symlink(volatile, linkedRoot)
    const probed: string[] = []
    const probe = async (candidate: string) => {
      probed.push(candidate)
      return program
    }

    expect(await pick(`${session}:${lasting}`, { volatileRoots: [volatile], probe })).toEqual({
      program: join(lasting, "node"),
      versioned: false,
    })
    expect(await pick(session, { volatileRoots: [linkedRoot], probe })).toEqual({ program, versioned: true })
    expect(probed).toEqual([join(lasting, "node")])
  })

  test("a file that is not executable, a missing file and a directory are skipped", async () => {
    const plain = join(root, "plain-file")
    await script(join(plain, "node"), printing(program), 0o644)
    await mkdir(join(root, "dir-node", "node"), { recursive: true })
    const probed: string[] = []
    const result = await pick([plain, join(root, "missing"), join(root, "dir-node")].join(":"), {
      probe: async (candidate) => {
        probed.push(candidate)
        return program
      },
    })
    expect(result).toEqual({ program, versioned: true })
    expect(probed).toEqual([])
  })

  test("relative and empty PATH entries are skipped", async () => {
    await script(join(root, "shim", "node"), printing(program))
    const probed: string[] = []
    const result = await pick(`:relative/bin:.::${join(root, "shim")}`, {
      probe: async (candidate) => {
        probed.push(candidate)
        return program
      },
    })
    expect(result.program).toBe(join(root, "shim", "node"))
    expect(probed).toEqual([join(root, "shim", "node")])
  })

  test("a probe that fails, throws or times out is skipped", async () => {
    await script(program, printing(program))
    await script(join(root, "fails", "node"), "exit 3")
    await script(join(root, "empty", "node"), "exit 0")
    // The probe's PATH holds only the candidates, so sleep is named by its path.
    await script(join(root, "slow", "node"), `/bin/sleep 30 || exit 1; ${printing(program)}`)
    const path = ["fails", "empty", "slow"].map((name) => join(root, name)).join(":")
    expect(await pick(path, { timeoutMs: 200 })).toEqual({ program, versioned: true })
    expect(
      await pick(path, {
        probe: async () => {
          throw new Error("boom")
        },
      }),
    ).toEqual({ program, versioned: true })
  })

  test("a probe answer that names no file is skipped", async () => {
    const answer = join(root, "no-such-program")
    await script(join(root, "vanished", "node"), printing(answer))
    expect(await pick(join(root, "vanished"))).toEqual({ program, versioned: true })
  })

  test("the probe runs with exactly PATH and HOME, from the given directory", async () => {
    const calls: Array<{ candidate: string; env: Record<string, string>; cwd: string }> = []
    await script(join(root, "shim", "node"), printing(program))
    const path = `${join(root, "shim")}:${join(root, "shim")}`
    const home = join(root, "home")
    await pick(path, {
      home,
      cwd: "/",
      probe: async (candidate, env, dir) => {
        calls.push({ candidate, env, cwd: dir })
        return undefined
      },
    })
    expect(calls).toEqual([{ candidate: join(root, "shim", "node"), env: { PATH: path, HOME: home }, cwd: "/" }])
  })
})
