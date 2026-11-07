import { describe, expect, test } from "bun:test"
import { selectTools, type ToolSettings } from "./core/tool"
import { PROJECT } from "./project"
import { ALL_TOOLS } from "./tools"

describe("the registry", () => {
  test("every tool id is unique", () => {
    const ids = ALL_TOOLS.map((spec) => spec.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every tool id starts with the package's tool prefix", () => {
    const stray = ALL_TOOLS.filter((spec) => !spec.id.startsWith(`${PROJECT.toolPrefix}_`)).map((spec) => spec.id)
    expect(stray).toEqual([])
  })

  test("every tool belongs to a toolset the package defines", () => {
    const stray = ALL_TOOLS.filter((spec) => !PROJECT.toolsets.includes(spec.toolset)).map((spec) => spec.id)
    expect(stray).toEqual([])
  })
})

describe("the files toolset", () => {
  const toolsets = { names: PROJECT.toolsets, defaults: PROJECT.defaultToolsets }
  const ids = (settings: ToolSettings) => selectTools(ALL_TOOLS, settings, toolsets).map((spec) => spec.id)

  test("is off by default, and on when asked for by toolset or by tool", () => {
    expect(ids({})).not.toContain("whatsapp_file_save")
    expect(ids({ toolsets: ["files"] })).toContain("whatsapp_file_save")
    expect(ids({ toolsets: "all" })).toContain("whatsapp_file_save")
    expect(ids({ tools: ["whatsapp_file_save"] })).toContain("whatsapp_file_save")
  })

  test("registers no write tool when the setting is read-only", () => {
    expect(ids({ toolsets: "all", read_only: true })).not.toContain("whatsapp_file_save")
  })
})

describe("the package's toolsets", () => {
  test("none is listed twice", () => {
    expect(new Set(PROJECT.toolsets).size).toBe(PROJECT.toolsets.length)
  })

  test("the default toolsets are among them", () => {
    const stray = PROJECT.defaultToolsets.filter((name) => !PROJECT.toolsets.includes(name))
    expect(stray).toEqual([])
  })
})
