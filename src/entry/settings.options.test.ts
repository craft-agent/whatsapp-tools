import { describe, expect, test } from "bun:test"
import { settingsFromOptions } from "./settings"
import { failure, profile } from "./settings.testing"

const fromOptions = (options: Record<string, unknown> | undefined, env: Record<string, string | undefined> = {}) =>
  settingsFromOptions(options, env, profile)

describe("settingsFromOptions", () => {
  test("gives no setting for no options", () => {
    expect(fromOptions(undefined)).toEqual({ state_dir: expect.any(String) })
    expect(fromOptions({})).toEqual({ state_dir: expect.any(String) })
  })

  test("reads each option", () => {
    expect(
      fromOptions({
        toolsets: ["alpha", "beta"],
        read_only: true,
        tools: ["demo_thing_read"],
        exclude_tools: ["a"],
        state_dir: "/custom/state",
      }),
    ).toEqual({
      toolsets: ["alpha", "beta"],
      read_only: true,
      tools: ["demo_thing_read"],
      exclude_tools: ["a"],
      state_dir: "/custom/state",
    })
    expect(fromOptions({ toolsets: "all" }).toolsets).toBe("all")
    expect(fromOptions({ toolsets: ["alpha", "all"] }).toolsets).toBe("all")
    expect(fromOptions({ toolsets: [] }).toolsets).toBeUndefined()
  })

  test("falls back to the environment, and an option wins over it", () => {
    const env = {
      DEMO_TOOLSETS: "gamma",
      DEMO_READ_ONLY: "true",
      DEMO_TOOLS: "a,b",
      DEMO_STATE_DIR: "/env/state",
    }
    expect(fromOptions({}, env)).toEqual({
      toolsets: ["gamma"],
      read_only: true,
      tools: ["a", "b"],
      state_dir: "/env/state",
    })
    expect(
      fromOptions({ toolsets: ["beta"], read_only: false, state_dir: "/opt/state" }, { ...env, DEMO_READ_ONLY: "yes" }),
    ).toEqual({
      toolsets: ["beta"],
      read_only: false,
      tools: ["a", "b"],
      state_dir: "/opt/state",
    })
  })

  test("an option of the wrong type is rejected, naming it", () => {
    expect(failure(() => fromOptions({ toolsets: "alpha" })).message).toContain('"toolsets"')
    expect(failure(() => fromOptions({ toolsets: [1] })).message).toContain('"toolsets"')
    expect(failure(() => fromOptions({ read_only: "true" })).message).toContain('"read_only"')
    expect(failure(() => fromOptions({ tools: "a" })).message).toContain('"tools"')
    expect(failure(() => fromOptions({ exclude_tools: [null] })).message).toContain('"exclude_tools"')
    expect(failure(() => fromOptions({ state_dir: 123 })).message).toContain('"state_dir"')
    expect(failure(() => fromOptions({ state_dir: false })).message).toContain('"state_dir"')
    expect(failure(() => fromOptions({ state_dir: "relative" })).message).toContain('"state_dir"')
  })

  test("an unknown toolset or option is rejected, naming it", () => {
    const toolset = failure(() => fromOptions({ toolsets: ["bogus"] })).message
    expect(toolset).toContain('"bogus"')
    expect(toolset).toContain('option "toolsets"')
    expect(failure(() => fromOptions({ confirm: "harness" })).message).toContain('"confirm"')
  })

  test("a bad environment variable is rejected only when no option overrides it", () => {
    expect(failure(() => fromOptions({}, { DEMO_READ_ONLY: "yes" })).message).toContain("DEMO_READ_ONLY")
    expect(fromOptions({ read_only: true }, { DEMO_READ_ONLY: "yes" }).read_only).toBe(true)
  })
})
