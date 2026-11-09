import { describe, expect, test } from "bun:test"
import { isToolError } from "../core"
import { resolveSendDirs } from "./send-dirs"

const given = (...texts: string[]) => texts.map((text) => ({ text, source: "DEMO_SEND_DIRS" }))

describe("resolveSendDirs", () => {
  test("is empty when none are given", () => {
    expect(resolveSendDirs([], { HOME: "/home/user" })).toEqual([])
  })

  test("returns each absolute path, resolved, in order", () => {
    expect(resolveSendDirs(given("/var/a/../a", "/var/b"), {})).toEqual(["/var/a", "/var/b"])
  })

  test("keeps a directory named twice once, in the order first given", () => {
    expect(resolveSendDirs(given("/b", "/a", "/b/", "/a/../a"), {})).toEqual(["/b", "/a"])
  })

  test("expands ~ and ~/x against the home directory", () => {
    expect(resolveSendDirs(given("~", "~/shared"), { HOME: "/home/user" })).toEqual(["/home/user", "/home/user/shared"])
  })

  test("refuses a relative, ~user or blank entry, naming the source", () => {
    for (const text of ["relative/path", "~otheruser/files", "   "]) {
      try {
        resolveSendDirs(given("/ok", text), { HOME: "/home/user" })
        expect().fail(`expected ${JSON.stringify(text)} to be rejected`)
      } catch (error) {
        expect(isToolError(error) && error.code).toBe("invalid_argument")
        expect((error as Error).message).toContain("DEMO_SEND_DIRS")
        expect((error as Error).message).toContain("must be an absolute path")
      }
    }
  })
})
