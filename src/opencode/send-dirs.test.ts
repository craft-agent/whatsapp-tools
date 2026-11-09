import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, type ToolSpec } from "../core"
import { PROFILE } from "./testing"
import type { V1ToolContext, V2Context, V2Tool } from "./types"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"

describe("OpenCode send_dirs setting", () => {
  const SESSION_ID = "ses_send"

  function sendTool(recorder: { target?: readonly string[]; execute?: readonly string[] }): ToolSpec {
    return defineTool({
      id: "demo_send_tool",
      title: "Send Tool",
      description: "Send Tool",
      toolset: "alpha",
      class: "add",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async targets(_args, ctx) {
        recorder.target = ctx.sendDirs
        return ["target-resource"]
      },
      async execute(_args, ctx) {
        recorder.execute = ctx.sendDirs
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

    test("passes sendDirs from options, then from DEMO_SEND_DIRS, into the call", async () => {
      const recorder: { target?: readonly string[]; execute?: readonly string[] } = {}
      const fromOptions = await createV1Server([sendTool(recorder)], { profile: PROFILE })(
        {},
        { send_dirs: ["/v1/a", "/v1/b"] },
      )
      await fromOptions.tool.demo_send_tool!.execute({}, context)
      expect(recorder.target).toEqual(["/v1/a", "/v1/b"])
      expect(recorder.execute).toEqual(["/v1/a", "/v1/b"])

      const fromEnv = await createV1Server([sendTool(recorder)], {
        profile: PROFILE,
        env: { DEMO_SEND_DIRS: "/v1/env" },
      })({}, {})
      await fromEnv.tool.demo_send_tool!.execute({}, context)
      expect(recorder.execute).toEqual(["/v1/env"])
    })

    test("rejects an invalid send_dirs option", async () => {
      const server = createV1Server([], { profile: PROFILE })
      await expect(server({}, { send_dirs: "/a,/b" })).rejects.toThrow('Option "send_dirs"')
      await expect(server({}, { send_dirs: ["relative/path"] })).rejects.toThrow('Option "send_dirs"')
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

    test("passes sendDirs from options into the call", async () => {
      const recorder: { target?: readonly string[]; execute?: readonly string[] } = {}
      const tools = new Map<string, V2Tool>()
      await createV2Setup([sendTool(recorder)], { profile: PROFILE })(v2Context({ send_dirs: ["/v2/a"] }, tools))
      const signal = new AbortController().signal
      await tools.get("demo_send_tool")!.execute({}, { sessionID: SESSION_ID, signal })
      expect(recorder.target).toEqual(["/v2/a"])
      expect(recorder.execute).toEqual(["/v2/a"])
    })

    test("rejects an invalid send_dirs option", async () => {
      const setup = createV2Setup([], { profile: PROFILE })
      await expect(setup(v2Context({ send_dirs: ["relative/path"] }))).rejects.toThrow('Option "send_dirs"')
      await expect(setup(v2Context({ send_dirs: 7 }))).rejects.toThrow('Option "send_dirs"')
    })
  })
})
