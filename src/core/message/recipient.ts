import { refuseExcludedChat } from "../chat/excluded"
import { chatKind, chatNumber, parseChatJid, type ChatKind } from "../chat/jid"
import { openMirror, type Mirror } from "../chat/mirror"
import { checkNumbers } from "../contact/check"
import type { CheckEntry } from "../contact/schema"
import { ToolError, isAbortError, isToolError } from "../errors"
import type { ToolContext } from "../tool"
import type { LabelPaths } from "../whatsapp/labels"
import { MESSAGE_ID_FORM } from "../whatsapp/media"
import { CHECKED_NUMBER } from "../whatsapp/operations"
import { LONE_SURROGATE } from "../whatsapp/send-outcome"
import { isServiceNotRunning } from "../whatsapp/service-client"

/** What names the tool that lists the chats, in the message that asks for a JID. */
const CHAT_FINDER = "whatsapp_chat_read list"

/** The servers of the JIDs a send is refused for: a channel, and a broadcast list or the status feed. */
const REFUSED_SERVERS: ReadonlySet<string> = new Set(["newsletter", "broadcast"])

/** The kinds of chat a send goes to. */
const SEND_KINDS: ReadonlySet<string> = new Set(["person", "group"])

/** The refusal of a send to anything but a person or a group. */
export const PEOPLE_AND_GROUPS_ONLY =
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
  "forbidden",
  "invalid_argument",
  "not_found",
  "unauthenticated",
  "upstream_error",
])

/** What a text sent to the service has to say about its length: the most it takes and the words for one over it. */
export type TextRules = {
  /** The most characters it has, counted as code points. */
  maxCharacters: number
  /** The message for a text of `length` characters, which is over `maxCharacters`. */
  tooLong(length: number): string
}

/** The chat JID `given` names, as the tool `toolId` takes it; `invalid_argument` for a name or a number. */
export function chatOf(given: string | undefined, toolId: string): string {
  return parseChatJid(given, "chat", toolId, CHAT_FINDER)
}

function serverOf(jid: string): string {
  return jid.slice(jid.lastIndexOf("@") + 1)
}

/** The refusal of a chat a send never goes to by its server alone (a channel, a broadcast list, the status feed); undefined for any other. */
export function refusedServerError(chat: string): ToolError | undefined {
  return REFUSED_SERVERS.has(serverOf(chat)) ? new ToolError("invalid_argument", PEOPLE_AND_GROUPS_ONLY) : undefined
}

/** The chat JID `given` names, refused unless it is one a send goes to by its server alone (not a channel or a broadcast list), before anything is read. */
export function checkedChat(given: string | undefined, toolId: string): string {
  const chat = chatOf(given, toolId)
  const refused = refusedServerError(chat)
  if (refused) throw refused
  return chat
}

/** The text to send: trimmed, not empty, without a NUL, and within the length `rules` give, counted as code points. */
export function checkedText(given: string, { maxCharacters, tooLong }: TextRules): string {
  const text = given.trim()
  if (text === "") throw new ToolError("invalid_argument", "text is empty; there is nothing to send.")
  if (text.includes("\0")) throw new ToolError("invalid_argument", "text must not contain a NUL character.")
  if (LONE_SURROGATE.test(text)) {
    throw new ToolError("invalid_argument", "text holds half of a character, which would arrive as another one.")
  }
  const length = [...text].length
  if (length > maxCharacters) throw new ToolError("invalid_argument", tooLong(length))
  return text
}

/** The message id `name` names, or `invalid_argument` naming `name`. The value is not echoed. */
export function messageIdOf(given: string, name: string): string {
  if (!MESSAGE_ID_FORM.test(given)) {
    throw new ToolError(
      "invalid_argument",
      `${name} must be a message id as whatsapp_chat_read gives it: letters, digits, \`.\`, \`_\` and \`-\`.`,
    )
  }
  return given
}

/** The message id `reply_to` names, or `invalid_argument` naming `reply_to`. The text is not echoed. */
export function replyToOf(given: string): string {
  return messageIdOf(given, "reply_to")
}

/** The error for a sync service that is not running, saying that a send or an action needs it. Nothing left. */
export function serviceNotRunning(error: ToolError): ToolError {
  return new ToolError(
    "upstream_error",
    `${error.message} Sends and actions go through the sync service (see whatsapp_account_read). Nothing was sent or changed.`,
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

/**
 * What a send to the chat gives when the mirror does not hold it and WhatsApp cannot vouch for the number: the order of
 * `requireRegistered`, ending in the no-answer error where it would ask WhatsApp. An excluded chat is refused with it,
 * without asking.
 */
export function unknownRecipient(chat: string, replyTo: string | undefined): ToolError {
  const refused = refusedServerError(chat)
  if (refused) return refused
  const number = chatNumber(chat)
  if (number === undefined || !CHECKED_NUMBER.test(number)) return new ToolError("not_found", NOT_IN_MIRROR)
  if (replyTo !== undefined) return new ToolError("not_found", NOTHING_TO_QUOTE)
  return new ToolError("upstream_error", NO_ANSWER)
}

/** The `gate` of a send tool: refuses an excluded chat as `unknownRecipient` does, and a malformed setting. */
export function sendGate(args: { chat: string; reply_to?: string }, ctx: Pick<ToolContext, "options">): void {
  refuseExcludedChat(ctx, args.chat, (chat) => unknownRecipient(chat, args.reply_to))
}

/** Checks that the chat is one a send goes to, and that the message to reply to is in it; a new person is checked with WhatsApp. */
export async function checkRecipient(
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

/** What a send of `subject` (`message` or `file`) that may have left is told as. */
export function uncertainMessage(subject: string): string {
  return `The ${subject} may have been sent. Read the chat with whatsapp_chat_read and ask the user before sending it again; never send it again on your own.`
}

/**
 * The error to throw for a call to the sync service that failed. The service not running and the codes it answers
 * only for a send that never left keep their meaning, an abort before the hand-off stays an abort (the client
 * reports one after it as `uncertain`), and anything else is `uncertain`, since the `subject` may have gone out;
 * `uncertain` is the message it carries, by default the one `uncertainMessage` gives for a send of the `subject`.
 */
export function deliveryFailure(error: unknown, subject: string, uncertain = uncertainMessage(subject)): unknown {
  if (isServiceNotRunning(error)) return serviceNotRunning(error as ToolError)
  if (isAbortError(error)) return error
  if (isToolError(error) && NOT_SENT_CODES.has(error.code)) return error
  return new ToolError("uncertain", uncertain, { cause: error })
}
