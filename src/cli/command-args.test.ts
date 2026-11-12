import { describe, expect, test } from "bun:test"
import { failure, profile } from "../entry/settings.testing"
import { parseCommandStateDir } from "./command-args"
import type { CommandIo } from "./command-io"

const io = (env: Record<string, string | undefined> = {}): CommandIo => ({
  env,
  profile,
  stdout: () => {},
  stderr: () => {},
})

describe("parseCommandStateDir", () => {
  test("reads the state directory from the flag, which wins over the environment", () => {
    expect(parseCommandStateDir(["--state-dir", "/flag/state"], io({ DEMO_STATE_DIR: "/env/state" }))).toBe(
      "/flag/state",
    )
    expect(parseCommandStateDir([], io({ DEMO_STATE_DIR: "/env/state" }))).toBe("/env/state")
  })

  test("defaults the state directory under the home directory", () => {
    expect(parseCommandStateDir([], io({ HOME: "/home/user" }))).toBe("/home/user/.local/state/demo-tools")
  })

  test("takes a blank state directory for none", () => {
    expect(parseCommandStateDir(["--state-dir", " "], io({ HOME: "/home/user" }))).toBe(
      "/home/user/.local/state/demo-tools",
    )
  })

  test("refuses a relative state directory, naming the flag", () => {
    expect(failure(() => parseCommandStateDir(["--state-dir", "rel"], io())).message).toBe(
      "--state-dir must be an absolute path.",
    )
  })

  test("refuses every other setting's flag, naming it", () => {
    for (const argv of [
      ["--download-dir", "/x"],
      ["--send-dirs", "/x"],
      ["--tools", "a"],
      ["--note-text", "x"],
    ]) {
      expect(failure(() => parseCommandStateDir(argv, io())).message).toBe(`Unknown option "${argv[0]}".`)
    }
  })

  test("ignores the other settings' variables, even a bad one", () => {
    const env = { DEMO_DOWNLOAD_DIR: "rel", DEMO_SEND_DIRS: "rel", DEMO_STATE_DIR: "/env/state" }
    expect(parseCommandStateDir([], io(env))).toBe("/env/state")
  })
})
