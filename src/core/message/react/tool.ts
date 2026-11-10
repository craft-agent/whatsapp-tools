import { chatKind } from "../../chat/jid"
import { messageKind, readKinds } from "../../chat/kinds"
import { openMirror, type Mirror } from "../../chat/mirror"
import type { WacliMessage } from "../../chat/rows"
import { ToolError } from "../../errors"
import { formatLocalTime } from "../../time"
import { defineTool, type CallFact, type CallHeadline, type ToolContext } from "../../tool"
import { pickLabel, type LabelPaths } from "../../whatsapp/labels"
import { MESSAGE_REACT_DEADLINE_MS, MESSAGE_REACT_OP, reactAnswer, type ReactAnswer } from "../../whatsapp/react"
import { callService } from "../../whatsapp/service-client"
import { chatDisplayName, openPromptMirror, promptTime } from "../describe"
import { checkedEmoji } from "../emoji"
import { checkedChat, deliveryFailure, messageIdOf } from "../recipient"
import { actionChat, actionMessage, actionTargets, type ActionChat } from "../target"
import { MESSAGE_WORDS } from "../words"
import { REACT_NOTE, input, output, type MessageReactInput, type MessageReactOutput } from "./schema"
import { reactionSender } from "./sender"
import { REACT_WORDS } from "./words"

const TOOL_ID = "whatsapp_message_react"

const UNCERTAIN_REACTION =
  "The reaction may have gone out. Read the chat with whatsapp_chat_read before reacting again; never repeat it on your own."

const NOT_REACTABLE = "A call or a vote on a poll cannot be reacted to. Nothing was changed."

const EMOJI_OR_REMOVE =
  "Give exactly one of emoji (the reaction) and remove: true (to take the user's reaction off). Nothing was changed."

/** The arguments of a call as far as they can be checked without the mirror; `emoji` is null to remove the reaction. */
type ReactRequest = { chat: string; id: string; emoji: string | null }

/** What the mirror says of the call: the chat's name and fact, the message, and who wrote it as WhatsApp must be told (undefined when it is not). */
type ReactTarget = ActionChat & { row: WacliMessage; sender: string | undefined }

/** The emoji to react with, or null to remove the reaction; `invalid_argument` unless exactly one of the two is asked for. */
function reactionOf({ emoji, remove }: MessageReactInput): string | null {
  const removes = remove === true
  if (removes === (emoji !== undefined)) throw new ToolError("invalid_argument", EMOJI_OR_REMOVE)
  return emoji === undefined ? null : checkedEmoji(emoji)
}

function requestOf(args: MessageReactInput): ReactRequest {
  return {
    chat: checkedChat(args.chat, TOOL_ID),
    id: messageIdOf(args.id, "id"),
    emoji: reactionOf(args),
  }
}

/** Refuses a call row and a poll vote or an added option, which are not messages anyone reacts to; a poll itself is one. */
async function requireReactable(mirror: Mirror, chat: string, row: WacliMessage): Promise<void> {
  const kind = messageKind(row, await readKinds(mirror, chat, [row]))
  if (kind !== undefined && kind !== "poll") throw new ToolError("invalid_argument", NOT_REACTABLE)
}

/** Reads the mirror for the chat and the message, and refuses what the reaction would be refused for. */
async function targetOf(mirror: Mirror, { chat, id }: ReactRequest): Promise<ReactTarget> {
  const described = await actionChat(mirror, chat)
  const row = await actionMessage(mirror, chat, id)
  await requireReactable(mirror, chat, row)
  const sender = reactionSender(row, chat, chatKind("", chat) === "group" ? "group" : "person")
  return { ...described, row, sender }
}

/** The headline of a reaction with `emoji`, or of the removal of the user's reaction when it is null, in the chat called `chat`. */
function headlineOf(emoji: string | null, chat: string): CallHeadline {
  return emoji === null
    ? { text: REACT_WORDS.removeHeadline, values: { chat } }
    : { text: REACT_WORDS.headline, values: { emoji, chat } }
}

/** The `From` fact: the user, or the author of the message as the mirror names them. */
function fromFact({ row, sender }: ReactTarget): CallFact {
  return {
    label: REACT_WORDS.fromLabel,
    value: row.FromMe ? { text: REACT_WORDS.fromMe } : chatDisplayName(sender ?? row.SenderJID, row.SenderName),
  }
}

/** The sync service's answer to the reaction, with `uncertain` told in the tool's words. */
async function requestReaction(
  paths: LabelPaths,
  request: ReactRequest,
  sender: string | undefined,
  ctx: ToolContext,
): Promise<ReactAnswer> {
  let data: unknown
  try {
    data = await callService(
      paths,
      MESSAGE_REACT_OP,
      {
        chat: request.chat,
        id: request.id,
        reaction: request.emoji ?? "",
        ...(sender === undefined ? {} : { sender }),
      },
      { mode: "write", timeoutMs: MESSAGE_REACT_DEADLINE_MS, signal: ctx.signal },
    )
  } catch (error) {
    throw deliveryFailure(error, "reaction", UNCERTAIN_REACTION)
  }
  const answer = reactAnswer.safeParse(data)
  if (!answer.success) throw new ToolError("uncertain", UNCERTAIN_REACTION, { cause: answer.error })
  return answer.data
}

/** The `whatsapp_message_react` tool definition. */
export const whatsappMessageReact = defineTool({
  id: TOOL_ID,
  title: REACT_WORDS.title,
  intent: REACT_WORDS.intent,
  description: [
    "Reacts with exactly one emoji to a message in a person's or a group's chat, the user's own or someone else's, or removes the user's reaction with `remove: true`; give `emoji` or `remove`, never both. A call or a vote on a poll cannot be reacted to.",
    "A new reaction replaces the user's earlier one on the message.",
    "`chat` and `id` are as whatsapp_chat_read gives them.",
    "It needs the account's sync service running.",
    "The result means WhatsApp accepted the reaction, not that it was delivered or seen.",
    "A failure `uncertain` means the reaction may have gone out: read the chat with whatsapp_chat_read before reacting again.",
    "`errors.record` says when the reaction was accepted but could not be written to the mirror.",
    "Only when the user asked for this reaction.",
  ].join(" "),
  toolset: "actions",
  class: "overwrite",
  input,
  output,
  targets: actionTargets(TOOL_ID),
  async describe(args, ctx) {
    const request = requestOf(args)
    const mirror = await openPromptMirror(ctx, args.account)
    const target = await targetOf(mirror, request)
    return {
      headline: headlineOf(request.emoji, target.name),
      facts: [
        target.fact,
        fromFact(target),
        { label: MESSAGE_WORDS.sentLabel, value: promptTime(Date.parse(target.row.Timestamp)) },
      ],
    }
  },
  async execute(args, ctx): Promise<MessageReactOutput> {
    const request = requestOf(args)
    const stateDir = ctx.stateDir
    if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
    const paths = await pickLabel(stateDir, args.account)

    const { sender } = await targetOf(openMirror(paths, ctx.signal), request)
    const accepted = await requestReaction(paths, request, sender, ctx)
    return {
      chat: request.chat,
      id: request.id,
      emoji: request.emoji,
      time: formatLocalTime(accepted.accepted_ms),
      ...(accepted.store_warning === undefined ? {} : { errors: { record: accepted.store_warning } }),
      note: REACT_NOTE,
    }
  },
})
