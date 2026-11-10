import type { z } from "zod"
import { ToolError } from "../../errors"
import { deliveryFailure } from "../../message/recipient"
import type { ToolContext } from "../../tool"
import { CHAT_STATE_DEADLINE_MS, chatStateAnswer, type ChatStateAnswer } from "../../whatsapp/chat-state"
import { pickLabel, type LabelPaths } from "../../whatsapp/labels"
import { callService } from "../../whatsapp/service-client"

/** What an `uncertain` change says: a state is set, not toggled, so calling again is safe. */
export const UNCERTAIN_CHANGE =
  "The change may have reached WhatsApp. It only sets a state, so calling the tool again with the same arguments is safe."

/** The paths of the account `account` names, or `internal_error` when the entry point supplied no state directory. */
export async function statePaths(ctx: ToolContext, account: string | undefined): Promise<LabelPaths> {
  const stateDir = ctx.stateDir
  if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
  return pickLabel(stateDir, account)
}

/** The sync service's answer to the change `op` with `args`, read as `answer` says, with `uncertain` told in the tool's words. */
export async function requestAnswer<S extends z.ZodType>(
  paths: LabelPaths,
  op: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  answer: S,
  uncertain: string,
): Promise<z.output<S>> {
  let data: unknown
  try {
    data = await callService(paths, op, args, { mode: "write", timeoutMs: CHAT_STATE_DEADLINE_MS, signal: ctx.signal })
  } catch (error) {
    throw deliveryFailure(error, "change", uncertain)
  }
  const parsed = answer.safeParse(data)
  if (!parsed.success) throw new ToolError("uncertain", uncertain, { cause: parsed.error })
  return parsed.data
}

/** The sync service's answer to the change `op` with `args`, with `uncertain` told in the tool's words. */
export function requestChange(
  paths: LabelPaths,
  op: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ChatStateAnswer> {
  return requestAnswer(paths, op, args, ctx, chatStateAnswer, UNCERTAIN_CHANGE)
}
