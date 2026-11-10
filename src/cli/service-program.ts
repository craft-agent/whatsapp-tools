import { access, constants, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { exec } from "../core/exec"

/** How long a candidate may take to name the program it starts. */
const PROBE_TIMEOUT_MS = 10_000

/** The name of the program looked for on the `PATH`. */
const PROGRAM_NAME = "node"

/** What a candidate is run with to make it print the program it starts. */
const PROBE_ARGS = ["-p", "process.execPath"]

/** Asks a candidate which program it starts, from `cwd` with exactly `env`; undefined when it cannot say. */
type Probe = (candidate: string, env: Record<string, string>, cwd: string) => Promise<string | undefined>

/** The program the service is installed with, and whether its path still holds its version. */
export type StableProgram = {
  program: string
  /** True when no program at a path without the version was found, so `program` goes when that version is removed. */
  versioned: boolean
}

export type StableProgramOptions = {
  /** The program the install would record, normally the running one. */
  program: string
  /** The running version without a leading `v`, for example `24.19.0`. */
  version: string
  /** The `PATH` the service is installed with. */
  path: string
  /** The `HOME` the service is installed with. */
  home: string
  /** The directory the service manager starts the service in. */
  cwd: string
  /**
   * Directories whose contents do not outlive a session or a restart, such as
   * the temporary and runtime directories; a candidate under one is skipped.
   */
  volatileRoots?: readonly string[]
  /** How long one candidate may take to answer. Defaults to 10 seconds. */
  timeoutMs?: number
  /** Replaces the run of a candidate; for tests. */
  probe?: Probe
}

function isVersionChar(char: string | undefined): boolean {
  return char !== undefined && (char === "." || (char >= "0" && char <= "9"))
}

/**
 * Whether `path` holds `version` as a whole: not next to another digit or dot,
 * so `v24.19.0` and `/24.19.0/` hold `24.19.0` but `124.19.0` and `24.19.0.1`
 * do not. A path that holds the version of its program goes when that version
 * is removed.
 */
export function pathHoldsVersion(path: string, version: string): boolean {
  if (version === "") return false
  for (let at = path.indexOf(version); at !== -1; at = path.indexOf(version, at + 1)) {
    if (!isVersionChar(path[at - 1]) && !isVersionChar(path[at + version.length])) return true
  }
  return false
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return false
  }
}

/** Each root as given and as resolved, so a root reached through a link still matches. */
async function resolveRoots(roots: readonly string[]): Promise<string[]> {
  const resolved = new Set<string>()
  for (const root of roots) {
    if (root === "" || !isAbsolute(root)) continue
    resolved.add(resolve(root))
    try {
      resolved.add(await realpath(root))
    } catch {
      // A root that does not exist holds no candidate, but its name still matches.
    }
  }
  return [...resolved]
}

function isUnder(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))
}

async function probeByRunning(
  candidate: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    const result = await exec([candidate, ...PROBE_ARGS], { cwd, env, timeoutMs })
    return result.code === 0 && !result.timedOut ? result.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * Picks the program to install the service with. A program whose path holds
 * its own version is replaced by the first `node` on `path` at a path without
 * it that, run as the service will be, starts the very same program; a shim or
 * a link that resolves elsewhere is skipped, and so is one under a volatile
 * root, which would be gone after a restart. When there is none, the program
 * stays and `versioned` is set so the caller can say it will not survive an
 * update. A program at a path without its version is kept without probing.
 * Problems with a candidate skip it and never throw.
 */
export async function pickStableProgram(options: StableProgramOptions): Promise<StableProgram> {
  const { program, version, path, home, cwd } = options
  if (!pathHoldsVersion(program, version)) return { program, versioned: false }

  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const probe: Probe = options.probe ?? ((candidate, env, dir) => probeByRunning(candidate, env, dir, timeoutMs))
  const env = { PATH: path, HOME: home }
  const volatileRoots = await resolveRoots(options.volatileRoots ?? [])

  const candidates = new Set<string>()
  for (const dir of path.split(":")) {
    if (dir !== "" && isAbsolute(dir)) candidates.add(join(dir, PROGRAM_NAME))
  }

  for (const candidate of candidates) {
    if (pathHoldsVersion(candidate, version) || isUnder(resolve(candidate), volatileRoots)) continue
    if (!(await isExecutableFile(candidate))) continue
    let started: string | undefined
    try {
      started = await probe(candidate, env, cwd)
    } catch {
      continue
    }
    if (started && (await sameFile(started, program))) return { program: candidate, versioned: false }
  }
  return { program, versioned: true }
}
