import { ANY_TARGET } from "../targets"
import type { ToolContext } from "../tool"
import { pickLabel } from "./labels"

/**
 * What a write to a label's account is named by: the label and then `parts` (the chat, and the message when the call
 * names one), joined by `/`. `*` when the label cannot be told.
 */
export async function labelTargets(
  ctx: Pick<ToolContext, "stateDir">,
  account: string | undefined,
  ...parts: string[]
): Promise<string[]> {
  if (!ctx.stateDir) return [ANY_TARGET]
  try {
    const { label } = await pickLabel(ctx.stateDir, account)
    return [[label, ...parts].join("/")]
  } catch {
    return [ANY_TARGET]
  }
}
