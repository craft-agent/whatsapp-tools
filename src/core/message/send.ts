import { chatKind, chatNumber, parseChatJid, type ChatKind } from "../chat/jid"
import { MESSAGE_ID_FORM } from "../whatsapp/media"
import { openMirror, type Mirror } from "../chat/mirror"
import { checkNumbers } from "../contact/check"
import type { CheckEntry } from "../contact/schema"
import { ToolError, isAbortError, isToolError } from "../errors"
import { ANY_TARGET } from "../targets"
import { defineTool, type ToolContext } from "../tool"
import { formatLocalTime } from "../time"
import { labelTargets } from "../whatsapp/label-targets"
import { pickLabel, type LabelPaths } from "../whatsapp/labels"
import { CHECKED_NUMBER } from "../whatsapp/operations"
import {
  LONE_SURROGATE,
  MESSAGE_SEND_DEADLINE_MS,
  MESSAGE_SEND_OP,
  MESSAGE_TEXT_MAX_CHARACTERS,
  sendAnswer,
} from "../whatsapp/send"
import { callService, isServiceNotRunning } from "../whatsapp/service-client"
import { SEND_NOTE, input, output, type MessageSendInput, type MessageSendOutput } from "./schema"

/** What names the tool that lists the chats, in the message that asks for a JID. */
const CHAT_FINDER = "whatsapp_chat_read list"

/** The servers of the JIDs a send is refused for: a channel, and a broadcast list or the status feed. */
const REFUSED_SERVERS: ReadonlySet<string> = new Set(["newsletter", "broadcast"])

/** The kinds of chat a send goes to. */
const SEND_KINDS: ReadonlySet<string> = new Set(["person", "group"])

const PEOPLE_AND_GROUPS_ONLY =
  "Sends go to people and groups only: a channel, a broadcast list and the status feed are refused, since each reaches people other than the ones the chat names. Nothing was sent."

const NOT_IN_MIRROR = `This chat is not in this account's mirror, and only a person's phone number can be checked with WhatsApp. Find the chat with ${CHAT_FINDER}; to write to someone new, use the \`chat\` that whatsapp_contact_read check gives. Nothing was sent.`

const NOTHING_TO_QUOTE =
  "This chat is not in this account's mirror, so there is no message of it to reply to. Send without reply_to. Nothing was sent."

const NOT_ON_WHATSAPP =
  "This number has no WhatsApp account, so nothing was sent. Check the number with whatsapp_contact_read check."

const NO_ANSWER =
  "WhatsApp gave no answer on whether this number has an account, so nothing was sent. Check again later with whatsapp_contact_read check."

/** The codes the service answers only for a send that never left; any other failure after the hand-off may have sent it. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "invalid_argument",
  "not_found",
  "unauthenticated",
  "upstream_error",
])

const UNCERTAIN_MESSAGE =
  "The message may have been sent. Read the chat with whatsapp_chat_read and ask the user before sending it again; never send it again on your own."

function chatOf(args: MessageSendInput): string {
  return parseChatJid(args.chat, "chat", "whatsapp_message_send", CHAT_FINDER)
}

function serverOf(jid: string): string {
  return jid.slice(jid.lastIndexOf("@") + 1)
}

/** The text to send: trimmed, not empty, without a NUL, and within the length one message takes, counted as code points. */
function checkedText(given: string): string {
  const text = given.trim()
  if (text === "") throw new ToolError("invalid_argument", "text is empty; there is nothing to send.")
  if (text.includes("\0")) throw new ToolError("invalid_argument", "text must not contain a NUL character.")
  if (LONE_SURROGATE.test(text)) {
    throw new ToolError("invalid_argument", "text holds half of a character, which would arrive as another one.")
  }
  const length = [...text].length
  if (length > MESSAGE_TEXT_MAX_CHARACTERS) {
    throw new ToolError(
      "invalid_argument",
      `text is ${length} characters and one message takes at most ${MESSAGE_TEXT_MAX_CHARACTERS}. Never shorten it yourself; split it into several sends only if the user agrees.`,
    )
  }
  return text
}

/** The message id `reply_to` names, or `invalid_argument` naming `reply_to`. The text is not echoed. */
function replyToOf(given: string): string {
  if (!MESSAGE_ID_FORM.test(given)) {
    throw new ToolError(
      "invalid_argument",
      "reply_to must be a message id as whatsapp_chat_read gives it: letters, digits, `.`, `_` and `-`.",
    )
  }
  return given
}

/** The error for a sync service that is not running, saying that a send needs it. Nothing was sent. */
function serviceNotRunning(error: ToolError): ToolError {
  return new ToolError(
    "upstream_error",
    `${error.message} A send goes through the sync service (see whatsapp_account_read). Nothing was sent.`,
    { cause: error },
  )
}

/** `not_found` unless the mirror holds the message `id` of `chat`. */
async function requireMessage(mirror: Mirror, chat: string, id: string): Promise<void> {
  const rows = await mirror.context(chat, id, 0, 0)
  if (!rows.some((row) => row.MsgID === id)) {
    throw new ToolError("not_found", "No message with this id in this chat to reply to. Nothing was sent.")
  }
}

/**
 * Lets a person the mirror does not hold through only when WhatsApp says their number has an account, since wacli
 * sends to an unregistered number without a word. Only a phone JID can be checked, and there is nothing to quote.
 */
async function requireRegistered(
  paths: LabelPaths,
  chat: string,
  replyTo: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const number = chatNumber(chat)
  if (number === undefined || !CHECKED_NUMBER.test(number)) throw new ToolError("not_found", NOT_IN_MIRROR)
  if (replyTo !== undefined) throw new ToolError("not_found", NOTHING_TO_QUOTE)
  let entry: CheckEntry | undefined
  try {
    entry = (await checkNumbers(paths, { method: "check", numbers: [number] }, signal)).numbers?.[0]
  } catch (error) {
    throw isServiceNotRunning(error) ? serviceNotRunning(error as ToolError) : error
  }
  if (entry?.status === "not_on_whatsapp") throw new ToolError("not_found", NOT_ON_WHATSAPP)
  if (entry?.status !== "on_whatsapp") throw new ToolError("upstream_error", NO_ANSWER)
  // WhatsApp may answer with another phone JID for the number; the chat named must be the one it answers with.
  if (entry.chat !== chat) {
    throw new ToolError(
      "invalid_argument",
      "WhatsApp knows this number under another chat. Send to the `chat` whatsapp_contact_read check gives for it. Nothing was sent.",
    )
  }
}

/** Checks that the chat is one a send goes to, and that the message to reply to is in it; a new person is checked with WhatsApp. */
async function checkRecipient(
  paths: LabelPaths,
  chat: string,
  replyTo: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const mirror = openMirror(paths, signal)
  let kind: ChatKind
  try {
    kind = chatKind((await mirror.chat(chat)).kind, chat)
  } catch (error) {
    if (!isToolError(error) || error.code !== "not_found") throw error
    return requireRegistered(paths, chat, replyTo, signal)
  }
  if (!SEND_KINDS.has(kind)) throw new ToolError("invalid_argument", PEOPLE_AND_GROUPS_ONLY)
  if (replyTo !== undefined) await requireMessage(mirror, chat, replyTo)
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
    if (isServiceNotRunning(error)) throw serviceNotRunning(error as ToolError)
    // An abort before the request reached the service sent nothing; the client reports one after it as uncertain.
    if (isAbortError(error)) throw error
    if (isToolError(error) && NOT_SENT_CODES.has(error.code)) throw error
    throw new ToolError("uncertain", UNCERTAIN_MESSAGE, { cause: error })
  }
  const answer = sendAnswer.safeParse(data)
  if (!answer.success) throw new ToolError("uncertain", UNCERTAIN_MESSAGE, { cause: answer.error })
  return answer.data
}

/** What the call writes to: the account and the chat, or `*` when either cannot be told. */
async function sendTargets(args: MessageSendInput, ctx: ToolContext): Promise<string[]> {
  let chat: string
  try {
    chat = chatOf(args)
  } catch {
    return [ANY_TARGET]
  }
  return labelTargets(ctx, args.account, chat)
}

/** The `whatsapp_message_send` tool definition. */
export const whatsappMessageSend = defineTool({
  id: "whatsapp_message_send",
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
    const chat = chatOf(args)
    if (REFUSED_SERVERS.has(serverOf(chat))) throw new ToolError("invalid_argument", PEOPLE_AND_GROUPS_ONLY)
    const text = checkedText(args.text)
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
