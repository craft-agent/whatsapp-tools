import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { isToolError } from "../core"
import type { EntryProfile } from "./profile"
import { resolveStateDir } from "./state-dir"

const profile: EntryProfile = {
  name: "demo-tools",
  envPrefix: "DEMO",
  toolsets: { names: ["alpha"], defaults: ["alpha"] },
}

describe("resolveStateDir", () => {
  describe("when given", () => {
    test("returns a resolved absolute path", () => {
      const result = resolveStateDir({ text: "/var/custom/state", source: "--state-dir" }, {}, profile)
      expect(result).toBe(resolve("/var/custom/state"))
    })

    test("expands ~ alone to the home directory", () => {
      const result = resolveStateDir({ text: "~", source: "--state-dir" }, { HOME: "/home/user" }, profile)
      expect(result).toBe("/home/user")
    })

    test("expands ~/x to a path under the home directory", () => {
      const result = resolveStateDir({ text: "~/my/state", source: "--state-dir" }, { HOME: "/home/user" }, profile)
      expect(result).toBe(resolve("/home/user", "my", "state"))
    })

    test("refuses a relative path and names the source", () => {
      for (const source of ["--state-dir", "DEMO_STATE_DIR", 'option "state_dir"']) {
        try {
          resolveStateDir({ text: "relative/path", source }, {}, profile)
          expect().fail("expected relative path to be rejected")
        } catch (error) {
          expect(isToolError(error) && error.code).toBe("invalid_argument")
          expect((error as Error).message).toContain(source)
          expect((error as Error).message).toContain("must be an absolute path")
        }
      }
    })

    test("refuses ~otheruser relative path and names the source", () => {
      try {
        resolveStateDir({ text: "~otheruser/state", source: "--state-dir" }, { HOME: "/home/user" }, profile)
        expect().fail("expected ~otheruser to be rejected")
      } catch (error) {
        expect(isToolError(error) && error.code).toBe("invalid_argument")
        expect((error as Error).message).toContain("--state-dir")
        expect((error as Error).message).toContain("must be an absolute path")
      }
    })

    test("refuses empty or whitespace string and names the source", () => {
      for (const text of ["", "   "]) {
        try {
          resolveStateDir({ text, source: "--state-dir" }, {}, profile)
          expect().fail("expected empty string to be rejected")
        } catch (error) {
          expect(isToolError(error) && error.code).toBe("invalid_argument")
          expect((error as Error).message).toContain("--state-dir")
        }
      }
    })
  })

  describe("when not given", () => {
    test("uses $XDG_STATE_HOME/<profile.name> when XDG_STATE_HOME is absolute", () => {
      const result = resolveStateDir(undefined, { XDG_STATE_HOME: "/xdg/state", HOME: "/home/user" }, profile)
      expect(result).toBe(resolve("/xdg/state", "demo-tools"))
    })

    test("ignores relative XDG_STATE_HOME and falls back to <home>/.local/state/<profile.name>", () => {
      const result = resolveStateDir(undefined, { XDG_STATE_HOME: "relative/xdg", HOME: "/home/user" }, profile)
      expect(result).toBe(resolve("/home/user", ".local", "state", "demo-tools"))
    })

    test("uses <home>/.local/state/<profile.name> when XDG_STATE_HOME is unset", () => {
      const result = resolveStateDir(undefined, { HOME: "/home/user" }, profile)
      expect(result).toBe(resolve("/home/user", ".local", "state", "demo-tools"))
    })

    test("falls back to homedir() when HOME is unset or relative", () => {
      const expected = resolve(homedir(), ".local", "state", "demo-tools")
      expect(resolveStateDir(undefined, {}, profile)).toBe(expected)
      expect(resolveStateDir(undefined, { HOME: "relative/home" }, profile)).toBe(expected)
    })
  })
})
