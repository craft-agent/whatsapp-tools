import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { directorySettings, toolDirectories } from "./directory"
import { profile } from "./settings.testing"

describe("directorySettings", () => {
  test("returns the directories given, as they are", () => {
    const options = { state_dir: "/var/state", download_dir: "/var/files", send_dirs: ["/var/a", "/var/b"] }
    expect(directorySettings(options, { HOME: "/home/user" }, profile)).toEqual({
      state_dir: "/var/state",
      download_dir: "/var/files",
      send_dirs: ["/var/a", "/var/b"],
    })
  })

  test("keeps a send directory named twice once, in the order first given", () => {
    expect(directorySettings({ send_dirs: ["/b", "/a", "/b", "/a"] }, {}, profile).send_dirs).toEqual(["/b", "/a"])
  })

  test("sends from no directory unless some are given", () => {
    expect(directorySettings({}, { HOME: "/home/user" }, profile).send_dirs).toEqual([])
  })

  test("ignores the options that are not directories", () => {
    expect(directorySettings({ note_text: "x" }, { HOME: "/home/user" }, profile)).toEqual({
      state_dir: "/home/user/.local/state/demo-tools",
      download_dir: "/home/user/Downloads/demo-tools",
      send_dirs: [],
    })
  })

  describe("state_dir when not given", () => {
    test("uses $XDG_STATE_HOME/<profile.name> when XDG_STATE_HOME is absolute", () => {
      const env = { XDG_STATE_HOME: "/xdg/state", HOME: "/home/user" }
      expect(directorySettings({}, env, profile).state_dir).toBe(resolve("/xdg/state", "demo-tools"))
    })

    test("ignores a relative XDG_STATE_HOME and falls back to <home>/.local/state/<profile.name>", () => {
      const env = { XDG_STATE_HOME: "relative/xdg", HOME: "/home/user" }
      expect(directorySettings({}, env, profile).state_dir).toBe(resolve("/home/user", ".local", "state", "demo-tools"))
    })

    test("uses <home>/.local/state/<profile.name> when XDG_STATE_HOME is unset", () => {
      expect(directorySettings({}, { HOME: "/home/user" }, profile).state_dir).toBe(
        resolve("/home/user", ".local", "state", "demo-tools"),
      )
    })

    test("falls back to homedir() when HOME is unset or relative", () => {
      const expected = resolve(homedir(), ".local", "state", "demo-tools")
      expect(directorySettings({}, {}, profile).state_dir).toBe(expected)
      expect(directorySettings({}, { HOME: "relative/home" }, profile).state_dir).toBe(expected)
    })

    test("is not moved by XDG_STATE_HOME once given", () => {
      expect(directorySettings({ state_dir: "/given" }, { XDG_STATE_HOME: "/xdg/state" }, profile).state_dir).toBe(
        "/given",
      )
    })
  })

  describe("download_dir when not given", () => {
    test("defaults to <home>/Downloads/<profile.name>", () => {
      expect(directorySettings({}, { HOME: "/home/user" }, profile).download_dir).toBe(
        "/home/user/Downloads/demo-tools",
      )
    })

    test("falls back to homedir() when HOME is unset or relative", () => {
      const expected = resolve(homedir(), "Downloads", "demo-tools")
      expect(directorySettings({}, {}, profile).download_dir).toBe(expected)
      expect(directorySettings({}, { HOME: "relative/home" }, profile).download_dir).toBe(expected)
    })
  })
})

describe("toolDirectories", () => {
  test("maps the settings to the properties of the tool context", () => {
    expect(toolDirectories({ state_dir: "/s", download_dir: "/d", send_dirs: ["/a"] })).toEqual({
      stateDir: "/s",
      downloadDir: "/d",
      sendDirs: ["/a"],
    })
  })
})
