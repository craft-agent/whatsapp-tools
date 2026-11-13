import { formatLocalTime } from "../../time"
import { defineTool } from "../../tool"
import { CHAT_ARCHIVE_OP } from "../../whatsapp/chat-state"
import { openPromptMirror } from "../../message/describe"
import { checkedChat } from "../../message/recipient"
import { actionChat, actionGate, actionTargets } from "../../message/target"
import { openMirror } from "../mirror"
import { ACCEPTED_NOTE, ARCHIVE_NOTE, archiveInput, archiveOutput, type ChatArchiveOutput } from "./schema"
import { requestChange, statePaths } from "./state"
import { ARCHIVE_WORDS } from "./words"

const TOOL_ID = "whatsapp_chat_archive"

/** The `whatsapp_chat_archive` tool definition. */
export const whatsappChatArchive = defineTool({
  id: TOOL_ID,
  title: ARCHIVE_WORDS.title,
  intent: ARCHIVE_WORDS.intent,
  description: [
    "Archives a person's or a group's chat the mirror holds, or unarchives it with `archived: false`. Archiving also unpins the chat.",
    "`chat` is as whatsapp_chat_read list gives it.",
    "It needs the account's sync service running.",
    "Only the user's own devices show it; nobody in the chat learns of it.",
    "The result means WhatsApp accepted the change.",
    "A failure `uncertain` means the change may have reached WhatsApp; it only sets a state, so calling again with the same arguments is safe.",
    "Only when the user asked for this change.",
  ].join(" "),
  toolset: "actions",
  class: "idempotent",
  input: archiveInput,
  output: archiveOutput,
  targets: actionTargets(TOOL_ID),
  gate: actionGate,
  async describe(args, ctx) {
    const chat = checkedChat(args.chat, TOOL_ID)
    const { name, fact } = await actionChat(await openPromptMirror(ctx, args.account), chat)
    return {
      headline: {
        text: args.archived ? ARCHIVE_WORDS.archiveHeadline : ARCHIVE_WORDS.unarchiveHeadline,
        values: { chat: name },
      },
      facts: [fact],
    }
  },
  async execute(args, ctx): Promise<ChatArchiveOutput> {
    const chat = checkedChat(args.chat, TOOL_ID)
    const paths = await statePaths(ctx, args.account)

    await actionChat(openMirror(paths, ctx.signal), chat)
    const accepted = await requestChange(paths, CHAT_ARCHIVE_OP, { chat, archived: args.archived }, ctx)
    return {
      chat,
      archived: args.archived,
      time: formatLocalTime(accepted.accepted_ms),
      note: args.archived ? `${ACCEPTED_NOTE} ${ARCHIVE_NOTE}` : ACCEPTED_NOTE,
    }
  },
})
