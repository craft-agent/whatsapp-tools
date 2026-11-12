import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { PROJECT } from "../project"
import type { EntryProfile } from "./profile"
import {
  forwardedVariables,
  parseDirectorySettings,
  parseSettings,
  parseStateDir,
  parseToolSettings,
  settingVariables,
} from "./settings"
import { failure, profile } from "./settings.testing"

const parse = (argv: string[], env: Record<string, string | undefined> = {}) => parseSettings(argv, env, profile)
const parseTool = (argv: string[], env: Record<string, string | undefined> = {}) =>
  parseToolSettings(argv, env, profile)

describe("settingVariables", () => {
  test("names each setting's variable under the profile's prefix", () => {
    expect(settingVariables(profile)).toEqual([
      "DEMO_TOOLSETS",
      "DEMO_READ_ONLY",
      "DEMO_TOOLS",
      "DEMO_EXCLUDE_TOOLS",
      "DEMO_CONFIRM",
      "DEMO_STATE_DIR",
      "DEMO_DOWNLOAD_DIR",
      "DEMO_SEND_DIRS",
      "DEMO_NOTE_TEXT",
    ])
  })

  test("uses the package's own prefix by default", () => {
    expect(settingVariables()).toEqual(
      settingVariables({ ...profile, envPrefix: PROJECT.envPrefix, options: PROJECT.options }),
    )
  })
})

describe("forwardedVariables", () => {
  test("lists the settings' variables, then the tool variables", () => {
    expect(forwardedVariables(profile, ["XDG_STATE_HOME"])).toEqual([...settingVariables(profile), "XDG_STATE_HOME"])
  })

  test("uses the package's own prefix and toolVariables by default", () => {
    expect(forwardedVariables()).toEqual([...settingVariables(), ...PROJECT.toolVariables])
  })
})

describe("parseSettings", () => {
  test("defaults to the harness confirming and no other setting", () => {
    expect(parse([])).toEqual({
      confirm: "harness",
      state_dir: expect.any(String),
      download_dir: expect.any(String),
      send_dirs: [],
      options: {},
    })
  })

  test("defaults download_dir to ~/Downloads/<profile.name>", () => {
    expect(parse([], { HOME: "/home/user" }).download_dir).toBe("/home/user/Downloads/demo-tools")
  })

  test("reads each flag", () => {
    expect(
      parse([
        "--toolsets",
        "alpha,beta",
        "--read-only",
        "--tools",
        "demo_thing_read",
        "--exclude-tools",
        "demo_thing_merge",
        "--confirm",
        "elicitation",
        "--state-dir",
        "/custom/state",
        "--download-dir",
        "/custom/downloads",
        "--send-dirs",
        "/custom/a, ~/b,,/custom/a",
      ]),
    ).toEqual({
      toolsets: ["alpha", "beta"],
      read_only: true,
      tools: ["demo_thing_read"],
      exclude_tools: ["demo_thing_merge"],
      confirm: "elicitation",
      state_dir: "/custom/state",
      download_dir: "/custom/downloads",
      send_dirs: ["/custom/a", resolve(homedir(), "b")],
      options: {},
    })
  })

  test("reads the --flag=value form", () => {
    expect(
      parse([
        "--toolsets=gamma",
        "--tools=a,b",
        "--exclude-tools=c",
        "--confirm=elicitation",
        "--read-only",
        "--state-dir=/custom/state",
        "--download-dir=~/saved",
        "--send-dirs=/custom/send",
      ]),
    ).toEqual({
      toolsets: ["gamma"],
      tools: ["a", "b"],
      exclude_tools: ["c"],
      read_only: true,
      confirm: "elicitation",
      state_dir: "/custom/state",
      download_dir: resolve(homedir(), "saved"),
      send_dirs: ["/custom/send"],
      options: {},
    })
  })

  test("falls back to the environment", () => {
    expect(
      parse([], {
        DEMO_TOOLSETS: "beta,gamma",
        DEMO_READ_ONLY: "true",
        DEMO_TOOLS: "x",
        DEMO_EXCLUDE_TOOLS: "y,z",
        DEMO_CONFIRM: "elicitation",
        DEMO_STATE_DIR: "/env/state",
        DEMO_DOWNLOAD_DIR: "/env/downloads",
        DEMO_SEND_DIRS: "/env/a, /env/b",
      }),
    ).toEqual({
      toolsets: ["beta", "gamma"],
      read_only: true,
      tools: ["x"],
      exclude_tools: ["y", "z"],
      confirm: "elicitation",
      state_dir: "/env/state",
      download_dir: "/env/downloads",
      send_dirs: ["/env/a", "/env/b"],
      options: {},
    })
  })

  test("names its environment variables after the package's prefix unless given a profile", () => {
    const variable = `${PROJECT.envPrefix}_READ_ONLY`
    expect(parseSettings([], { [variable]: "true" }).read_only).toBe(true)
    expect(parseSettings([], { DEMO_READ_ONLY: "true" }).read_only).toBeUndefined()
    expect(parse([], { [variable]: "true" }).read_only).toBeUndefined()
    expect(failure(() => parseSettings([], { [variable]: "yes" })).message).toContain(variable)
  })

  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["False", false],
  ])("DEMO_READ_ONLY=%s is %p", (value, expected) => {
    expect(parse([], { DEMO_READ_ONLY: value }).read_only).toBe(expected)
  })

  test.each(["yes", "on", "2", "enabled"])("DEMO_READ_ONLY=%s is rejected, naming the variable", (value) => {
    const message = failure(() => parse([], { DEMO_READ_ONLY: value })).message
    expect(message).toContain("DEMO_READ_ONLY")
    expect(message).toContain(`"${value}"`)
  })

  test("a flag-given --read-only is not blocked by a bad environment variable it overrides", () => {
    expect(parse(["--read-only"], { DEMO_READ_ONLY: "yes" }).read_only).toBe(true)
  })

  test("a flag wins over its environment variable", () => {
    const env = {
      DEMO_TOOLSETS: "gamma",
      DEMO_TOOLS: "x",
      DEMO_EXCLUDE_TOOLS: "y",
      DEMO_CONFIRM: "elicitation",
      DEMO_READ_ONLY: "0",
      DEMO_STATE_DIR: "/env/state",
      DEMO_DOWNLOAD_DIR: "/env/downloads",
      DEMO_SEND_DIRS: "/env/send",
    }
    expect(
      parse(
        [
          "--toolsets",
          "alpha",
          "--tools",
          "a",
          "--exclude-tools",
          "b",
          "--confirm",
          "harness",
          "--read-only",
          "--state-dir",
          "/flag/state",
          "--download-dir",
          "/flag/downloads",
          "--send-dirs",
          "/flag/send",
        ],
        env,
      ),
    ).toEqual({
      toolsets: ["alpha"],
      tools: ["a"],
      exclude_tools: ["b"],
      confirm: "harness",
      read_only: true,
      state_dir: "/flag/state",
      download_dir: "/flag/downloads",
      send_dirs: ["/flag/send"],
      options: {},
    })
  })

  test("an empty environment variable counts as unset", () => {
    expect(parse([], { DEMO_TOOLSETS: "", DEMO_CONFIRM: " ", DEMO_DOWNLOAD_DIR: "", DEMO_SEND_DIRS: " " })).toEqual({
      confirm: "harness",
      state_dir: expect.any(String),
      download_dir: expect.any(String),
      send_dirs: [],
      options: {},
    })
  })

  test("expands ~ in send_dirs and drops a directory named twice", () => {
    const env = { HOME: "/home/user" }
    expect(parse(["--send-dirs", "~/shared,/x,~/shared"], env).send_dirs).toEqual(["/home/user/shared", "/x"])
  })

  test("rejects a relative send_dirs entry in flag or environment, naming the source", () => {
    expect(failure(() => parse(["--send-dirs", "/ok,rel/path"])).message).toContain("--send-dirs")
    expect(failure(() => parse([], { DEMO_SEND_DIRS: "/ok,rel/path" })).message).toContain("DEMO_SEND_DIRS")
  })

  test("rejects a relative state_dir in flag or environment", () => {
    expect(failure(() => parse(["--state-dir", "rel/path"])).message).toContain("--state-dir")
    expect(failure(() => parse([], { DEMO_STATE_DIR: "rel/path" })).message).toContain("DEMO_STATE_DIR")
  })

  test("rejects a relative download_dir in flag or environment", () => {
    expect(failure(() => parse(["--download-dir", "rel/path"])).message).toContain("--download-dir")
    expect(failure(() => parse([], { DEMO_DOWNLOAD_DIR: "rel/path" })).message).toContain("DEMO_DOWNLOAD_DIR")
  })

  test("drops empty list items", () => {
    const settings = parse(["--toolsets", "alpha,,beta,", "--tools", ",a, ,b"])
    expect(settings.toolsets).toEqual(["alpha", "beta"])
    expect(settings.tools).toEqual(["a", "b"])
    expect(parse(["--toolsets", ","]).toolsets).toBeUndefined()
  })

  test('"all" turns on every toolset', () => {
    expect(parse(["--toolsets", "all"]).toolsets).toBe("all")
    expect(parse([], { DEMO_TOOLSETS: "all" }).toolsets).toBe("all")
  })

  test("the last of a repeated flag wins", () => {
    expect(parse(["--confirm", "elicitation", "--confirm=harness"]).confirm).toBe("harness")
  })

  test("an unknown flag or a stray argument is rejected, naming it", () => {
    expect(failure(() => parse(["--nope"])).message).toContain("--nope")
    expect(failure(() => parse(["--nope=1"])).message).toContain("--nope=1")
    expect(failure(() => parse(["alpha"])).message).toContain("alpha")
  })

  test("a flag without a value is rejected, naming it", () => {
    expect(failure(() => parse(["--toolsets"])).message).toContain("--toolsets")
    expect(failure(() => parse(["--tools", "--read-only"])).message).toContain("--tools")
    expect(failure(() => parse(["--read-only=1"])).message).toContain("--read-only")
  })

  test("a bad confirm mode is rejected, naming it", () => {
    expect(failure(() => parse(["--confirm", "ask"])).message).toContain('"ask"')
    expect(failure(() => parse([], { DEMO_CONFIRM: "ask" })).message).toContain("DEMO_CONFIRM")
  })

  test("an unknown toolset is rejected, naming it, where it came from and the toolsets there are", () => {
    const fromFlag = failure(() => parse(["--toolsets", "alpha,bogus"])).message
    expect(fromFlag).toContain('"bogus"')
    expect(fromFlag).toContain("--toolsets")
    for (const name of profile.toolsets.names) expect(fromFlag).toContain(name)
    expect(failure(() => parse([], { DEMO_TOOLSETS: "bogus" })).message).toContain("DEMO_TOOLSETS")
  })

  test("with no toolsets defined, a named toolset is rejected and the message says so", () => {
    const none: EntryProfile = { name: "demo-tools", envPrefix: "DEMO", toolsets: { names: [], defaults: [] } }
    expect(failure(() => parseSettings(["--toolsets", "alpha"], {}, none)).message).toContain("no toolsets are defined")
    expect(parseSettings(["--toolsets", "all"], {}, none).toolsets).toBe("all")
  })
})

describe("parseStateDir", () => {
  test("reads only the state directory, from the flag or the environment", () => {
    expect(parseStateDir(["--state-dir", "/flag/state"], { DEMO_STATE_DIR: "/env/state" }, profile)).toBe("/flag/state")
    expect(parseStateDir([], { DEMO_STATE_DIR: "/env/state" }, profile)).toBe("/env/state")
  })

  test("refuses --download-dir and any other settings flag, naming it", () => {
    expect(failure(() => parseStateDir(["--download-dir", "/x"], {}, profile)).message).toContain("--download-dir")
    expect(failure(() => parseStateDir(["--tools", "a"], {}, profile)).message).toContain("--tools")
  })

  test("refuses a tool option flag, naming it", () => {
    expect(failure(() => parseStateDir(["--note-text", "x"], {}, profile)).message).toBe(
      "Option --note-text is not available here.",
    )
  })
})

describe("parseDirectorySettings", () => {
  test("reads the state, download and send directories, from the flags or the environment", () => {
    const env = { DEMO_STATE_DIR: "/env/state", DEMO_DOWNLOAD_DIR: "/env/files", DEMO_SEND_DIRS: "/env/a,/env/b" }
    expect(
      parseDirectorySettings(
        ["--state-dir", "/flag/state", "--download-dir=/flag/files", "--send-dirs=/flag/a"],
        env,
        profile,
      ),
    ).toEqual({ state_dir: "/flag/state", download_dir: "/flag/files", send_dirs: ["/flag/a"], options: {} })
    expect(parseDirectorySettings([], env, profile)).toEqual({
      state_dir: "/env/state",
      download_dir: "/env/files",
      send_dirs: ["/env/a", "/env/b"],
      options: {},
    })
  })

  test("reads the package's own options beside the directories, from the flag or the environment", () => {
    expect(parseDirectorySettings(["--note-text", "flag"], { DEMO_NOTE_TEXT: "env" }, profile).options).toEqual({
      note_text: "flag",
    })
    expect(parseDirectorySettings([], { DEMO_NOTE_TEXT: "env" }, profile).options).toEqual({ note_text: "env" })
  })

  test("refuses any other settings flag, naming it", () => {
    for (const argv of [["--toolsets", "a"], ["--read-only"], ["--tools", "a"], ["--confirm", "harness"]]) {
      expect(failure(() => parseDirectorySettings(argv, {}, profile)).message).toBe(
        `Option ${argv[0]} is not available here.`,
      )
    }
  })
})

describe("parseToolSettings", () => {
  test("reads the tool settings and gives no confirm setting", () => {
    expect(parseTool([])).toEqual({
      state_dir: expect.any(String),
      download_dir: expect.any(String),
      send_dirs: [],
      options: {},
    })
    expect(
      parseTool(
        ["--toolsets=gamma", "--read-only", "--tools", "a", "--state-dir=/tool/state", "--download-dir=/tool/files"],
        { DEMO_EXCLUDE_TOOLS: "b" },
      ),
    ).toEqual({
      toolsets: ["gamma"],
      read_only: true,
      tools: ["a"],
      exclude_tools: ["b"],
      state_dir: "/tool/state",
      download_dir: "/tool/files",
      send_dirs: [],
      options: {},
    })
  })

  test("rejects --confirm in both forms, naming it", () => {
    expect(failure(() => parseTool(["--confirm", "harness"])).message).toContain("--confirm")
    expect(failure(() => parseTool(["--confirm=elicitation"])).message).toContain("--confirm")
  })

  test("ignores DEMO_CONFIRM, even a bad one", () => {
    expect(parseTool([], { DEMO_CONFIRM: "ask" })).toEqual({
      state_dir: expect.any(String),
      download_dir: expect.any(String),
      send_dirs: [],
      options: {},
    })
  })
})
