import { describe, expect, test } from "bun:test"
import { PROJECT } from "../project"
import { EXIT_USAGE } from "./cli"
import { cli } from "./testing"

describe("the commands a person runs", () => {
  test.each([
    [["pair", "--bogus"], 'Unknown option "--bogus".'],
    [["sync", "--bogus"], 'Unknown option "--bogus".'],
    [["service"], "No service command given; use service install|uninstall|status."],
    [["remove"], "Option --account is required."],
  ])("%j is routed to its command and fails as a usage error", async (argv, message) => {
    const run = await cli(argv as string[])
    expect(run.code).toBe(EXIT_USAGE)
    expect(run.stdout).toBe("")
    expect(run.stderr).toBe(`${PROJECT.cli}: ${message}\n`)
  })

  test("names them when the command is unknown, and takes no inherited property for a command", async () => {
    for (const name of ["bogus", "constructor", "toString"]) {
      const run = await cli([name])
      expect(run.code).toBe(EXIT_USAGE)
      expect(run.stderr).toContain(`Unknown command "${name}"`)
      expect(run.stderr).toContain("pair, sync, service or remove")
    }
  })
})
