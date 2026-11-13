import type { GrantContext, ToolOptions, ToolSpec, Translator } from "../core"
import { DESCRIBE_TIMEOUT_MS } from "../entry/description"
import { approvalOf } from "../entry/pin"
import { loadSkills } from "./skills"
import {
  harnessError,
  needsPermission,
  permissionMetadata,
  personOnlyIds,
  runTool,
  savedResources,
  selectedTools,
  type PluginDeps,
  type PluginDirectories,
} from "./shared"
import type { OpenCodePlugin, V2Context, V2Tool, V2ToolContext, V2ToolResult } from "./types"

/** The directory of a session, or `undefined` when the harness cannot name it. */
async function sessionDirectory(ctx: V2Context, sessionID: string): Promise<string | undefined> {
  try {
    return (await ctx.session.get({ sessionID })).location?.directory || undefined
  } catch {
    return undefined
  }
}

function v2Tool(
  ctx: V2Context,
  spec: ToolSpec,
  ownDir: string | undefined,
  directories: PluginDirectories,
  t: Translator,
  options: ToolOptions,
  grants: GrantContext,
): V2Tool {
  return {
    name: spec.id,
    description: spec.description,
    input: spec.input.strict(),
    output: spec.output,
    async execute(input: unknown, { sessionID, signal }: V2ToolContext): Promise<V2ToolResult> {
      const directory = await sessionDirectory(ctx, sessionID)
      const toolContext = { cwd: directory ?? process.cwd(), ownDir, ...directories, options, grants, signal }
      let pin: string | undefined
      if (needsPermission(spec)) {
        if (directory === undefined) {
          throw new Error(
            `invalid_argument: The session's directory could not be read, so ${spec.id} cannot tell what it changes; retry.`,
          )
        }
        const approval = await approvalOf(spec, input, toolContext, DESCRIBE_TIMEOUT_MS, t)
        if (approval.refused) throw harnessError(approval.refused)
        const { resources, description } = approval
        pin = approval.pin
        await ctx.permission.assert({
          action: spec.id,
          resources,
          save: savedResources(spec, resources),
          metadata: permissionMetadata(spec, input, resources, description, t),
          sessionID,
        })
      }
      const result = await runTool(spec, input, toolContext, pin)
      return { content: JSON.stringify(result), output: result }
    },
  }
}

/**
 * Makes the permission of each action in `ids` `ask`, since the host allows an
 * action no rule names; an effect of `deny` stays.
 */
async function askForActions(ctx: V2Context, ids: string[]): Promise<void> {
  const asked = new Set(ids)
  await ctx.permission.hook?.("evaluate", (event) => {
    if (asked.has(event.action) && event.effect !== "deny") event.effect = "ask"
  })
}

/**
 * The `setup` of the OpenCode V2 plugin: registers the tools the plugin
 * options select, each asking the harness's permission before a non-read call,
 * a rule that keeps a person-only tool asking whatever the rules say, and the
 * package's skills, those linked to a toolset only when the options leave that
 * toolset a selected tool. A settings mistake throws, so the harness reports
 * the plugin as failed.
 */
export function createV2Setup(specs: ToolSpec[], deps: PluginDeps = {}): OpenCodePlugin["setup"] {
  return async function setup(ctx: V2Context): Promise<void> {
    const selection = selectedTools(specs, ctx.options, deps)
    const tools = selection.tools.map((spec) =>
      v2Tool(ctx, spec, deps.ownDir, selection.directories, selection.translator, selection.options, selection.grants),
    )
    const skills =
      deps.skillsDir === undefined
        ? []
        : await loadSkills(deps.skillsDir, new Set(selection.tools.map((spec) => spec.toolset)))

    if (tools.length > 0) {
      await ctx.tool.transform((editor) => {
        for (const tool of tools) editor.add(tool)
      })
    }
    const personOnly = personOnlyIds(selection.tools)
    if (personOnly.length > 0) await askForActions(ctx, personOnly)
    if (skills.length > 0) {
      await ctx.skill.transform((editor) => {
        for (const skill of skills) editor.add(skill)
      })
    }
  }
}
