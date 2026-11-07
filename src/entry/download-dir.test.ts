import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { isToolError } from "../core"
import { resolveDownloadDir } from "./download-dir"
import type { EntryProfile } from "./profile"

const profile: EntryProfile = {
  name: "demo-tools",
  envPrefix: "DEMO",
  toolsets: { names: ["alpha"], defaults: ["alpha"] },
}

describe("resolveDownloadDir", () => {
  test("returns the given absolute path, resolved", () => {
    expect(resolveDownloadDir({ text: "/var/files/../files", source: "--download-dir" }, {}, profile)).toBe(
      resolve("/var/files"),
    )
  })

  test("expands ~ and ~/x against the home directory", () => {
    const env = { HOME: "/home/user" }
    expect(resolveDownloadDir({ text: "~", source: "--download-dir" }, env, profile)).toBe("/home/user")
    expect(resolveDownloadDir({ text: "~/saved", source: "--download-dir" }, env, profile)).toBe("/home/user/saved")
  })

  test("refuses a relative, ~user, empty or blank path, naming the source", () => {
    for (const text of ["relative/path", "~otheruser/files", "", "   "]) {
      try {
        resolveDownloadDir({ text, source: "DEMO_DOWNLOAD_DIR" }, { HOME: "/home/user" }, profile)
        expect().fail(`expected ${JSON.stringify(text)} to be rejected`)
      } catch (error) {
        expect(isToolError(error) && error.code).toBe("invalid_argument")
        expect((error as Error).message).toContain("DEMO_DOWNLOAD_DIR")
        expect((error as Error).message).toContain("must be an absolute path")
      }
    }
  })

  test("defaults to <home>/Downloads/<profile.name>", () => {
    expect(resolveDownloadDir(undefined, { HOME: "/home/user" }, profile)).toBe("/home/user/Downloads/demo-tools")
  })

  test("falls back to homedir() when HOME is unset or relative", () => {
    const expected = resolve(homedir(), "Downloads", "demo-tools")
    expect(resolveDownloadDir(undefined, {}, profile)).toBe(expected)
    expect(resolveDownloadDir(undefined, { HOME: "relative/home" }, profile)).toBe(expected)
  })
})
