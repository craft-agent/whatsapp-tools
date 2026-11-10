import { z } from "zod"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { MS_PER_MINUTE } from "../time"
import { notDispatched, sentOf, type SendOutcomeOptions } from "./send-outcome"
import { reachableChat } from "./send"
import type { ServiceOperationContext } from "./service-socket"
import { execWacli } from "./wacli"

/** The name of the service operation that archives or unarchives one chat. */
export const CHAT_ARCHIVE_OP = "chat_archive"

/** The name of the service operation that pins or unpins one chat. */
export const CHAT_PIN_OP = "chat_pin"

/** The name of the service operation that mutes or unmutes one chat. */
export const CHAT_MUTE_OP = "chat_mute"

/**
 * How long a change of a chat's state may take in all, which is the deadline its caller gives the service. Before it
 * writes, wacli syncs the app state and may wait up to 5 minutes for keys the phone has not sent; its own `--timeout`
 * below bounds that wait, and a change that ran into it is `uncertain`, since the patch may still have gone out.
 */
export const CHAT_STATE_DEADLINE_MS = 90_000

/** How long wacli itself may take for it (its `--timeout`), so that its own time-out is what is reported. */
const CHAT_STATE_WACLI_TIMEOUT_MS = 60_000

/** How long the process may run before it is killed: past wacli's own time-out, within the service's deadline. */
const CHAT_STATE_PROCESS_LIMIT_MS = 75_000

const MS_PER_HOUR = 60 * MS_PER_MINUTE

/** The mutes the phone offers: 8 hours, a week, always, or none (unmuting). */
export const MUTE_CHOICES = ["8_hours", "1_week", "always", "off"] as const

/** One of `MUTE_CHOICES`. */
export type MuteChoice = (typeof MUTE_CHOICES)[number]

/** How long each timed mute lasts. */
export const MUTE_DURATION_MS = { "8_hours": 8 * MS_PER_HOUR, "1_week": 168 * MS_PER_HOUR } as const

/** wacli's `--duration` for a mute that lasts forever. */
const FOREVER = "0"

/** wacli's text when the chat is missing. */
const MISSING_CHAT = /^--chat is required/i

/** wacli's text when the running sync is too old to take the change. */
const SYNC_TOO_OLD = /^the running sync process does not support delegated chats/i

/** The arguments of `chat_archive`. */
const archiveArguments = z.strictObject({ chat: reachableChat, archived: z.boolean() })

/** The arguments of `chat_pin`. */
const pinArguments = z.strictObject({ chat: reachableChat, pinned: z.boolean() })

/** The arguments of `chat_mute`. */
const muteArguments = z.strictObject({ chat: reachableChat, mute: z.enum(MUTE_CHOICES) })

/** What wacli prints for a change it made: `ok`, beside the action and the chat it names. */
const changedState = z.object({ ok: z.literal(true) })

/** What each chat state operation returns: when wacli reported the change accepted (in milliseconds). */
export const chatStateAnswer = z.object({ accepted_ms: z.number().int().nonnegative() })

/** What wacli reported of a change WhatsApp accepted. */
export type ChatStateAnswer = z.infer<typeof chatStateAnswer>

/** The error for a wacli text that says the request ended before anything was changed, else undefined. */
function notSent(text: string): ToolError | undefined {
  const known = notDispatched(text, "change")
  if (known) return known
  if (MISSING_CHAT.test(text)) {
    return new ToolError("invalid_argument", "wacli was given no chat. Nothing was changed.")
  }
  if (SYNC_TOO_OLD.test(text)) {
    return new ToolError(
      "upstream_error",
      "The wacli the sync service runs is too old to change a chat's state. Update wacli and restart the sync service, then try again. Nothing was changed.",
    )
  }
  return undefined
}

/** How the failures of a change are told. */
const OUTCOME: SendOutcomeOptions = {
  subject: "change",
  processLimitMs: CHAT_STATE_PROCESS_LIMIT_MS,
  notSent,
}

/** A `wacli chats` subcommand, and the flags besides `--chat` it takes. */
type ChatStateCommand = { action: string; flags?: string[] }

/** The answer of a change that succeeded, else the error it ended with; a success that proves no change is `uncertain`. */
function answerOf(result: ExecResult): ChatStateAnswer {
  sentOf(result, changedState, OUTCOME)
  return { accepted_ms: Date.now() }
}

/**
 * Runs `wacli chats <command>` for `chat` through the running sync: wacli runs without `--read-only`, so it hands the
 * change to the sync, which holds the store. wacli first syncs the app state and may wait for the phone's keys, so a
 * change can run into its time-out; that, and any failure after the hand-off, is `uncertain`.
 */
async function changeChatState(
  { action, flags = [] }: ChatStateCommand,
  chat: string,
  { paths, env, signal }: ServiceOperationContext,
): Promise<ChatStateAnswer> {
  const result = await execWacli(
    paths,
    ["chats", action, "--timeout", `${CHAT_STATE_WACLI_TIMEOUT_MS / 1000}s`, "--chat", chat, ...flags],
    { env, mode: "write", signal, timeoutMs: CHAT_STATE_PROCESS_LIMIT_MS },
  )
  return answerOf(result)
}

/** Archives the chat, or unarchives it with `archived: false`, through the running sync; archiving also unpins it. */
export async function archiveChat(args: unknown, context: ServiceOperationContext): Promise<ChatStateAnswer> {
  const parsed = archiveArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError("invalid_argument", "chat_archive takes chat (a JID) and archived (true or false).")
  }
  const { chat, archived } = parsed.data
  return changeChatState({ action: archived ? "archive" : "unarchive" }, chat, context)
}

/** Pins the chat, or unpins it with `pinned: false`, through the running sync; wacli checks no limit on pinned chats. */
export async function pinChat(args: unknown, context: ServiceOperationContext): Promise<ChatStateAnswer> {
  const parsed = pinArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError("invalid_argument", "chat_pin takes chat (a JID) and pinned (true or false).")
  }
  const { chat, pinned } = parsed.data
  return changeChatState({ action: pinned ? "pin" : "unpin" }, chat, context)
}

/** The `wacli chats` command that sets `choice`. */
function muteCommand(choice: MuteChoice): ChatStateCommand {
  if (choice === "off") return { action: "unmute" }
  const duration = choice === "always" ? FOREVER : `${MUTE_DURATION_MS[choice] / MS_PER_HOUR}h`
  return { action: "mute", flags: ["--duration", duration] }
}

/** Mutes the chat for 8 hours, a week or always, or unmutes it with `off`, through the running sync. */
export async function muteChat(args: unknown, context: ServiceOperationContext): Promise<ChatStateAnswer> {
  const parsed = muteArguments.safeParse(args)
  if (!parsed.success) {
    throw new ToolError("invalid_argument", `chat_mute takes chat (a JID) and mute (${MUTE_CHOICES.join(", ")}).`)
  }
  const { chat, mute } = parsed.data
  return changeChatState(muteCommand(mute), chat, context)
}
