import { ToolError } from "../../errors"
import { openPromptMirror } from "../../message/describe"
import { checkedChat } from "../../message/recipient"
import { actionChat, actionGate, actionTargets } from "../../message/target"
import { formatLocalTime } from "../../time"
import { defineTool, type CallFact } from "../../tool"
import { CHAT_MARK_OP, chatMarkAnswer, type ChatMarkAnswer } from "../../whatsapp/chat-state"
import { openMirror } from "../mirror"
import { ACCEPTED_NOTE, RECEIPTS_NOTES, markInput, markOutput, type ChatMarkOutput } from "./schema"
import { UNCERTAIN_CHANGE, requestAnswer, statePaths } from "./state"
import { MARK_WORDS } from "./words"

const TOOL_ID = "whatsapp_chat_mark"

const UNCERTAIN_RECEIPTS =
  "The read receipts may have gone out. Calling again is safe, but it may send them again, which only tells the senders once more that the chat was read."

const RECEIPTS_NEED_READ = "receipts only goes with read: true. Nothing was changed."

/** The arguments of a call as far as they can be checked without the mirror. */
type MarkRequest = { chat: string; read: boolean; receipts: boolean }

function requestOf(args: { chat: string; read: boolean; receipts?: boolean }): MarkRequest {
  const receipts = args.receipts ?? false
  if (receipts && !args.read) throw new ToolError("invalid_argument", RECEIPTS_NEED_READ)
  return { chat: checkedChat(args.chat, TOOL_ID), read: args.read, receipts }
}

/** The `Receipts` fact of marking a chat read: whether the senders are told. Marking unread has none. */
function receiptsFacts({ read, receipts }: MarkRequest): CallFact[] {
  if (!read) return []
  const text = receipts ? MARK_WORDS.receiptsSent : MARK_WORDS.receiptsNone
  return [{ label: MARK_WORDS.receiptsLabel, value: { text } }]
}

/** The note of a result that asked for read receipts, chosen from what the receipts did. */
function receiptsNote({ receipts, senders_told: sendersTold }: ChatMarkAnswer): string {
  if (receipts === undefined) return RECEIPTS_NOTES.unrecorded
  if (receipts === 0) return RECEIPTS_NOTES.none
  if (!sendersTold) return RECEIPTS_NOTES.ownDevices
  return `Read receipts went to the senders of ${receipts} ${receipts === 1 ? "message" : "messages"}, who may see them as read.`
}

/** The `whatsapp_chat_mark` tool definition. */
export const whatsappChatMark = defineTool({
  id: TOOL_ID,
  title: MARK_WORDS.title,
  intent: MARK_WORDS.intent,
  description: [
    "Marks a person's or a group's chat the mirror holds as read, or as unread with `read: false`, on the user's own devices; nobody in the chat learns of it, and marking it read clears the phone's unread mark.",
    "`receipts: true`, only with `read: true` and only when the user asks for it, sends read receipts for up to 100 unread messages of the chat instead, which tells their senders that the chat was read (unless the user turned read receipts off); the result says how many messages they went for. In that mode the tool sends the receipts and clears only the mirror's unread count, so the phone's unread mark may stay until the user opens the chat. Without `receipts`, nobody learns anything.",
    "`chat` is as whatsapp_chat_read list gives it.",
    "It needs the account's sync service running.",
    "The result means WhatsApp accepted the change.",
    "A failure `uncertain` means the change may have reached WhatsApp; it only sets a state, so calling again with the same arguments is safe, though receipts that went out may go out again.",
    "`errors.record` says when the receipts went out but the mirror's unread count could not be cleared.",
    "Only when the user asked for this change.",
  ].join(" "),
  toolset: "actions",
  class: "idempotent",
  input: markInput,
  output: markOutput,
  targets: actionTargets(TOOL_ID),
  gate: actionGate,
  async describe(args, ctx) {
    const request = requestOf(args)
    const { name, fact } = await actionChat(await openPromptMirror(ctx, args.account), request.chat)
    return {
      headline: { text: request.read ? MARK_WORDS.readHeadline : MARK_WORDS.unreadHeadline, values: { chat: name } },
      facts: [fact, ...receiptsFacts(request)],
    }
  },
  async execute(args, ctx): Promise<ChatMarkOutput> {
    const request = requestOf(args)
    const paths = await statePaths(ctx, args.account)

    await actionChat(openMirror(paths, ctx.signal), request.chat)
    const accepted = await requestAnswer(
      paths,
      CHAT_MARK_OP,
      request,
      ctx,
      chatMarkAnswer,
      request.receipts ? UNCERTAIN_RECEIPTS : UNCERTAIN_CHANGE,
    )
    return {
      chat: request.chat,
      read: request.read,
      ...(accepted.receipts === undefined ? {} : { receipts: accepted.receipts, senders_told: accepted.senders_told }),
      time: formatLocalTime(accepted.accepted_ms),
      ...(accepted.store_warning === undefined ? {} : { errors: { record: accepted.store_warning } }),
      note: request.receipts ? receiptsNote(accepted) : ACCEPTED_NOTE,
    }
  },
})
