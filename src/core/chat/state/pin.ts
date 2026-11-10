import { ToolError } from "../../errors"
import { formatLocalTime } from "../../time"
import { defineTool } from "../../tool"
import { CHAT_PIN_OP } from "../../whatsapp/chat-state"
import { openPromptMirror } from "../../message/describe"
import { checkedChat } from "../../message/recipient"
import { actionChat, actionTargets, type ActionChat } from "../../message/target"
import { openMirror, type Mirror } from "../mirror"
import { ACCEPTED_NOTE, PIN_LIMIT, pinInput, pinOutput, type ChatPinOutput } from "./schema"
import { requestChange, statePaths } from "./state"
import { PIN_WORDS } from "./words"

const TOOL_ID = "whatsapp_chat_pin"

const PIN_LIMIT_REACHED =
  "WhatsApp pins at most three chats, and three are pinned. Unpin one first. Nothing was changed."

/** Refuses pinning a chat that is not pinned yet while the mirror holds the most chats WhatsApp pins: `forbidden`. */
async function requireRoom(mirror: Mirror, chat: string): Promise<void> {
  const pinned = await mirror.chats({ pinned: true })
  if (pinned.length >= PIN_LIMIT && !pinned.some((row) => row.jid === chat)) {
    throw new ToolError("forbidden", PIN_LIMIT_REACHED)
  }
}

/** Reads the mirror for the chat and refuses what the change would be refused for; only a pinning meets the limit. */
async function targetOf(mirror: Mirror, chat: string, pinned: boolean): Promise<ActionChat> {
  const described = await actionChat(mirror, chat)
  if (pinned) await requireRoom(mirror, chat)
  return described
}

/** The `whatsapp_chat_pin` tool definition. */
export const whatsappChatPin = defineTool({
  id: TOOL_ID,
  title: PIN_WORDS.title,
  intent: PIN_WORDS.intent,
  description: [
    "Pins a person's or a group's chat the mirror holds to the top of the chat list, or unpins it with `pinned: false`. WhatsApp pins at most three chats; pinning another while three are pinned is refused.",
    "`chat` is as whatsapp_chat_read list gives it.",
    "It needs the account's sync service running.",
    "Only the user's own devices show it; nobody in the chat learns of it.",
    "The result means WhatsApp accepted the change.",
    "A failure `uncertain` means the change may have reached WhatsApp; it only sets a state, so calling again with the same arguments is safe.",
    "Only when the user asked for this change.",
  ].join(" "),
  toolset: "actions",
  class: "idempotent",
  input: pinInput,
  output: pinOutput,
  targets: actionTargets(TOOL_ID),
  async describe(args, ctx) {
    const chat = checkedChat(args.chat, TOOL_ID)
    const { name, fact } = await targetOf(await openPromptMirror(ctx, args.account), chat, args.pinned)
    return {
      headline: { text: args.pinned ? PIN_WORDS.pinHeadline : PIN_WORDS.unpinHeadline, values: { chat: name } },
      facts: [fact],
    }
  },
  async execute(args, ctx): Promise<ChatPinOutput> {
    const chat = checkedChat(args.chat, TOOL_ID)
    const paths = await statePaths(ctx, args.account)

    await targetOf(openMirror(paths, ctx.signal), chat, args.pinned)
    const accepted = await requestChange(paths, CHAT_PIN_OP, { chat, pinned: args.pinned }, ctx)
    return { chat, pinned: args.pinned, time: formatLocalTime(accepted.accepted_ms), note: ACCEPTED_NOTE }
  },
})
