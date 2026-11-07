import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, type ToolSpec } from "../core"
import { PROJECT } from "../project"
import { PROFILE } from "./testing"
import type { V1ToolContext, V2Context, V2Tool } from "./types"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"

describe("OpenCode download_dir setting", () => {
  const SESSION_ID = "ses_download"

  function downloadTool(recorder: { target?: string; execute?: string }): ToolSpec {
    return defineTool({
      id: "demo_download_tool",
      title: "Download Tool",
      description: "Download Tool",
      toolset: "alpha",
      class: "add",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async targets(_args, ctx) {
        recorder.target = ctx.downloadDir
        return ["target-resource"]
      },
      async execute(_args, ctx) {
        recorder.execute = ctx.downloadDir
        return { ok: true }
      },
    })
  }

  describe("V1", () => {
    const context: V1ToolContext = {
      directory: "/work/project",
      worktree: "/work/project",
      abort: new AbortController().signal,
      async ask() {},
    }

    test("passes downloadDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const { tool } = await createV1Server([downloadTool(recorder)], { profile: PROFILE })(
        {},
        { download_dir: "/v1/custom/downloads" },
      )
      await tool.demo_download_tool!.execute({}, context)
      expect(recorder.target).toBe("/v1/custom/downloads")
      expect(recorder.execute).toBe("/v1/custom/downloads")
    })

    test("falls back to environment variable DEMO_DOWNLOAD_DIR", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const { tool } = await createV1Server([downloadTool(recorder)], {
        profile: PROFILE,
        env: { DEMO_DOWNLOAD_DIR: "/v1/env/downloads" },
      })({}, {})
      await tool.demo_download_tool!.execute({}, context)
      expect(recorder.execute).toBe("/v1/env/downloads")
    })

    test("defaults to ~/Downloads/<profile.name>", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const { tool } = await createV1Server([downloadTool(recorder)], {
        profile: PROFILE,
        env: { HOME: "/home/user" },
      })({}, {})
      await tool.demo_download_tool!.execute({}, context)
      expect(recorder.execute).toBe("/home/user/Downloads/demo-tools")
    })

    test("names the program in the context of both calls", async () => {
      const programs: Array<string | undefined> = []
      const spec = defineTool({
        id: "demo_program_tool",
        title: "Program Tool",
        description: "Program Tool",
        toolset: "alpha",
        class: "add",
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        async targets(_args, ctx) {
          programs.push(ctx.programName)
          return ["target-resource"]
        },
        async execute(_args, ctx) {
          programs.push(ctx.programName)
          return { ok: true }
        },
      })
      const { tool } = await createV1Server([spec], { profile: PROFILE })({}, {})
      await tool.demo_program_tool!.execute({}, context)
      expect(programs).toEqual([PROJECT.name, PROJECT.name])
    })

    test("rejects an invalid download_dir option", async () => {
      const server = createV1Server([], { profile: PROFILE })
      await expect(server({}, { download_dir: 123 })).rejects.toThrow('Option "download_dir"')
      await expect(server({}, { download_dir: "relative/path" })).rejects.toThrow('Option "download_dir"')
    })
  })

  describe("V2", () => {
    const v2Context = (options: Record<string, unknown>, tools = new Map<string, V2Tool>()): V2Context => ({
      options,
      session: {
        async get() {
          return { location: { directory: "/work/project" } }
        },
      },
      permission: { async assert() {} },
      tool: { transform: async (cb) => cb({ add: (t) => tools.set(t.name, t) }) },
      skill: { transform: async () => {} },
    })

    test("passes downloadDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const tools = new Map<string, V2Tool>()
      await createV2Setup([downloadTool(recorder)], { profile: PROFILE })(
        v2Context({ download_dir: "/v2/custom/downloads" }, tools),
      )
      const signal = new AbortController().signal
      await tools.get("demo_download_tool")!.execute({}, { sessionID: SESSION_ID, signal })
      expect(recorder.target).toBe("/v2/custom/downloads")
      expect(recorder.execute).toBe("/v2/custom/downloads")
    })

    test("rejects an invalid download_dir option", async () => {
      await expect(
        createV2Setup([], { profile: PROFILE })(v2Context({ download_dir: "relative/path" })),
      ).rejects.toThrow('Option "download_dir"')
    })
  })
})
