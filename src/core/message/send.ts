import { ToolError } from "../errors"
import { ANY_TARGET } from "../targets"
import { defineTool, type ToolContext } from "../tool"
import { formatLocalTime } from "../time"
import { labelTargets } from "../whatsapp/label-targets"
import { pickLabel, type LabelPaths } from "../whatsapp/labels"
import { sendAnswer } from "../whatsapp/send-outcome"
import { MESSAGE_SEND_DEADLINE_MS, MESSAGE_SEND_OP, MESSAGE_TEXT_MAX_CHARACTERS } from "../whatsapp/send"
import { callService } from "../whatsapp/service-client"
import {
  checkRecipient,
  checkedChat,
  checkedText,
  chatOf,
  deliveryFailure,
  replyToOf,
  uncertainMessage,
} from "./recipient"
import { SEND_NOTE, input, output, type MessageSendInput, type MessageSendOutput } from "./schema"

const TOOL_ID = "whatsapp_message_send"

/** What a text is checked against: the length one message takes, and the words for a text over it. */
const TEXT_RULES = {
  maxCharacters: MESSAGE_TEXT_MAX_CHARACTERS,
  tooLong: (length: number) =>
    `text is ${length} characters and one message takes at most ${MESSAGE_TEXT_MAX_CHARACTERS}. Never shorten it yourself; split it into several sends only if the user agrees.`,
}

/** The sync service's answer to the send: what WhatsApp accepted, else the error, with `uncertain` told in the tool's words. */
async function deliver(paths: LabelPaths, chat: string, text: string, replyTo: string | undefined, ctx: ToolContext) {
  let data: unknown
  try {
    data = await callService(
      paths,
      MESSAGE_SEND_OP,
      { chat, text, ...(replyTo === undefined ? {} : { reply_to: replyTo }) },
      { mode: "write", timeoutMs: MESSAGE_SEND_DEADLINE_MS, signal: ctx.signal },
    )
  } catch (error) {
    throw deliveryFailure(error, "message")
  }
  const answer = sendAnswer.safeParse(data)
  if (!answer.success) throw new ToolError("uncertain", uncertainMessage("message"), { cause: answer.error })
  return answer.data
}

/** What the call writes to: the account and the chat, or `*` when either cannot be told. */
async function sendTargets(args: MessageSendInput, ctx: ToolContext): Promise<string[]> {
  let chat: string
  try {
    chat = chatOf(args.chat, TOOL_ID)
  } catch {
    return [ANY_TARGET]
  }
  return labelTargets(ctx, args.account, chat)
}

/** The `whatsapp_message_send` tool definition. */
export const whatsappMessageSend = defineTool({
  id: TOOL_ID,
  title: "Send a message",
  description: [
    "Sends one text to a person or a group; channels, broadcast lists and the status feed are refused.",
    "`chat` is a JID from whatsapp_chat_read list, or for someone new the `chat` that whatsapp_contact_read check gives (the tool asks WhatsApp whether the number has an account first), never a name or a number.",
    "It needs the account's sync service running.",
    `\`text\` is sent exactly as given, surrounding blank space trimmed, at most ${MESSAGE_TEXT_MAX_CHARACTERS} characters; it is never split or shortened without the user's agreement, and no link preview is fetched.`,
    "`reply_to` quotes a message of the same chat by its id.",
    "The result means WhatsApp accepted the message, not that it was delivered or read.",
    "A failure `uncertain` means the message may have gone out: read the chat with whatsapp_chat_read and ask the user before sending it again, never send it again blindly.",
    "The chat's unread count in the local mirror drops, as when the user writes in it, and no read receipt is sent.",
    "`errors.record` says when the message was sent but could not be written to the mirror.",
  ].join(" "),
  toolset: "sends",
  class: "add",
  input,
  output,
  targets: sendTargets,
  async execute(args, ctx): Promise<MessageSendOutput> {
    const chat = checkedChat(args.chat, TOOL_ID)
    const text = checkedText(args.text, TEXT_RULES)
    const replyTo = args.reply_to === undefined ? undefined : replyToOf(args.reply_to)
    const stateDir = ctx.stateDir
    if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
    const paths = await pickLabel(stateDir, args.account)

    await checkRecipient(paths, chat, replyTo, ctx.signal)
    const accepted = await deliver(paths, chat, text, replyTo, ctx)
    return {
      chat,
      id: accepted.id,
      time: formatLocalTime(accepted.accepted_ms),
      ...(accepted.store_warning === undefined ? {} : { errors: { record: accepted.store_warning } }),
      note: SEND_NOTE,
    }
  },
})
