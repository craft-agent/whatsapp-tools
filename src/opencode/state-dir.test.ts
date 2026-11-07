import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, type ToolSpec } from "../core"
import { PROFILE } from "./testing"
import type { V1ToolContext, V2Context, V2Tool } from "./types"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"

describe("OpenCode state_dir setting", () => {
  const SESSION_ID = "ses_state"

  function stateTool(recorder: { target?: string; execute?: string }): ToolSpec {
    return defineTool({
      id: "demo_state_tool",
      title: "State Tool",
      description: "State Tool",
      toolset: "alpha",
      class: "add",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async targets(_args, ctx) {
        recorder.target = ctx.stateDir
        return ["target-resource"]
      },
      async execute(_args, ctx) {
        recorder.execute = ctx.stateDir
        return { ok: true }
      },
    })
  }

  describe("V1", () => {
    test("passes stateDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const context: V1ToolContext = {
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        async ask() {},
      }
      const { tool } = await createV1Server([stateTool(recorder)], { profile: PROFILE })(
        {},
        { state_dir: "/v1/custom/state" },
      )
      await tool.demo_state_tool!.execute({}, context)
      expect(recorder.target).toBe("/v1/custom/state")
      expect(recorder.execute).toBe("/v1/custom/state")
    })

    test("falls back to environment variable DEMO_STATE_DIR", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const context: V1ToolContext = {
        directory: "/work/project",
        worktree: "/work/project",
        abort: new AbortController().signal,
        async ask() {},
      }
      const { tool } = await createV1Server([stateTool(recorder)], {
        profile: PROFILE,
        env: { DEMO_STATE_DIR: "/v1/env/state" },
      })({}, {})
      await tool.demo_state_tool!.execute({}, context)
      expect(recorder.target).toBe("/v1/env/state")
      expect(recorder.execute).toBe("/v1/env/state")
    })

    test("rejects an invalid state_dir option", async () => {
      const server = createV1Server([], { profile: PROFILE })
      await expect(server({}, { state_dir: 123 })).rejects.toThrow('Option "state_dir"')
      await expect(server({}, { state_dir: "relative/path" })).rejects.toThrow('Option "state_dir"')
    })
  })

  describe("V2", () => {
    test("passes stateDir from options into permissionResources and runTool", async () => {
      const recorder: { target?: string; execute?: string } = {}
      const tools = new Map<string, V2Tool>()
      const ctx: V2Context = {
        options: { state_dir: "/v2/custom/state" },
        session: {
          async get() {
            return { location: { directory: "/work/project" } }
          },
        },
        permission: {
          async assert() {},
        },
        tool: { transform: async (cb) => cb({ add: (t) => tools.set(t.name, t) }) },
        skill: { transform: async () => {} },
      }
      await createV2Setup([stateTool(recorder)], { profile: PROFILE })(ctx)
      const signal = new AbortController().signal
      await tools.get("demo_state_tool")!.execute({}, { sessionID: SESSION_ID, signal })
      expect(recorder.target).toBe("/v2/custom/state")
      expect(recorder.execute).toBe("/v2/custom/state")
    })

    test("rejects an invalid state_dir option", async () => {
      const ctx: V2Context = {
        options: { state_dir: "relative/path" },
        session: {
          async get() {
            return {}
          },
        },
        permission: { async assert() {} },
        tool: { transform: async () => {} },
        skill: { transform: async () => {} },
      }
      await expect(createV2Setup([], { profile: PROFILE })(ctx)).rejects.toThrow('Option "state_dir"')
    })
  })
})
