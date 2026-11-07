import { rm } from "node:fs/promises"
import { labelPaths } from "../core/whatsapp/labels"
import { LABEL, shortTempDir } from "../core/whatsapp/sync.testing"
import { resetWacliCache } from "../core/whatsapp/wacli"
import { installFakeWacli, type FakeResponse, type FakeWacli } from "../core/whatsapp/wacli.testing"
import type { CommandIo } from "./command-io"

/** What a command did: its exit code and what it wrote. */
export type CommandRun = { code: number; stdout: string; stderr: string }

/** A command test's surroundings: a state directory and a fake wacli. */
export type CommandFixture = {
  fake: FakeWacli
  stateDir: string
  /** The label's paths under the state directory (`LABEL` by default). */
  paths(label?: string): ReturnType<typeof labelPaths>
  /** Runs `command` over the fixture's state directory and collects what it writes. */
  run(
    command: (argv: string[], io: CommandIo) => Promise<number>,
    args?: string[],
    overrides?: Partial<CommandIo>,
  ): Promise<CommandRun>
  /** Starts `command` without waiting for it; `output` is what it has written so far. */
  start(
    command: (argv: string[], io: CommandIo) => Promise<number>,
    args?: string[],
    overrides?: Partial<CommandIo>,
  ): { done: Promise<number>; output(): { stdout: string; stderr: string } }
  cleanup(): Promise<void>
}

/** Sets up a command test; the fake answers `responses`. Call `cleanup` afterwards. */
export async function commandFixture(responses: FakeResponse[] = []): Promise<CommandFixture> {
  resetWacliCache()
  const fake = await installFakeWacli()
  fake.setResponses(responses)
  const stateDir = await shortTempDir()

  const start: CommandFixture["start"] = (command, args = [], overrides = {}) => {
    let stdout = ""
    let stderr = ""
    const done = command([...args, "--state-dir", stateDir], {
      env: fake.env,
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      stdoutIsTTY: false,
      ...overrides,
    })
    return { done, output: () => ({ stdout, stderr }) }
  }

  return {
    fake,
    stateDir,
    paths: (label = LABEL) => labelPaths(stateDir, label),
    start,
    async run(command, args, overrides) {
      const { done, output } = start(command, args, overrides)
      const code = await done
      return { code, ...output() }
    },
    async cleanup() {
      await fake.cleanup()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}
