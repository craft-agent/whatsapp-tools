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

  test.each(["whatsapp_file_save", "whatsapp_file_send"])(
    "has %s off by default, and on when asked for by toolset or by tool",
    (id) => {
      expect(ids({})).not.toContain(id)
      expect(ids({ toolsets: ["files"] })).toContain(id)
      expect(ids({ toolsets: "all" })).toContain(id)
      expect(ids({ tools: [id] })).toContain(id)
    },
  )

  test("registers no write tool when the setting is read-only", () => {
    const files = ids({ toolsets: "all", read_only: true })
    expect(files).not.toContain("whatsapp_file_save")
    expect(files).not.toContain("whatsapp_file_send")
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
