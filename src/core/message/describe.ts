import { chatKind, chatNumber } from "../chat/jid"
import { findMessageRow } from "../chat/message-row"
import { openMirror, type Mirror } from "../chat/mirror"
import { ToolError, isToolError } from "../errors"
import { formatLocalTime } from "../time"
import type { CallFact, CallValue, ToolContext } from "../tool"
import { pickLabel } from "../whatsapp/labels"
import { CHECKED_NUMBER } from "../whatsapp/operations"
import { PEOPLE_AND_GROUPS_ONLY, notInMirror, nothingToQuote } from "./recipient"
import { MESSAGE_WORDS } from "./words"

/** The chat a send goes to, as its prompt names it: its name, its `Chat` fact, and whether the mirror holds it yet. */
export type DescribedChat = { name: string; fact: CallFact; isNew: boolean }

/** The characters of a local time an approval prompt keeps: `YYYY-MM-DD HH:mm`. */
const PROMPT_TIME_LENGTH = 16

/** A time as an approval prompt shows it: local time to the minute, `YYYY-MM-DD HH:mm`. */
export function promptTime(ms: number): string {
  return formatLocalTime(ms).slice(0, PROMPT_TIME_LENGTH).replace("T", " ")
}

/** What a chat or a sender is called: the mirror's name when it has one, else the phone number, else the JID. */
export function chatDisplayName(jid: string, mirrorName: string | undefined): string {
  const name = mirrorName?.trim()
  return name ? name : (chatNumber(jid) ?? jid)
}

/**
 * The name and the `Chat` fact of the chat a send goes to, read from the mirror only. A person or a group the mirror
 * holds is told by its kind; a phone number it does not hold is a new person; any other kind is `invalid_argument`
 * and any other missing chat `not_found`, as a send would refuse them.
 */
export async function describeChat(mirror: Mirror, jid: string): Promise<DescribedChat> {
  let row: Awaited<ReturnType<Mirror["chat"]>>
  try {
    row = await mirror.chat(jid)
  } catch (error) {
    if (!isToolError(error) || error.code !== "not_found") throw error
    const number = chatNumber(jid)
    if (number === undefined || !CHECKED_NUMBER.test(number)) throw notInMirror()
    return {
      name: number,
      fact: { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.newPerson } },
      isNew: true,
    }
  }
  const kind = chatKind(row.kind, jid)
  if (kind !== "person" && kind !== "group") throw new ToolError("invalid_argument", PEOPLE_AND_GROUPS_ONLY)
  return { name: chatDisplayName(jid, row.name), fact: chatKindFact(kind), isNew: false }
}

/** The `Chat` fact of a person's or a group's chat the mirror holds. */
export function chatKindFact(kind: "person" | "group"): CallFact {
  return {
    label: MESSAGE_WORDS.chatLabel,
    value: { text: kind === "person" ? MESSAGE_WORDS.person : MESSAGE_WORDS.group },
  }
}

/** The mirror of the label a prompt reads, or `internal_error` when the entry point supplied no state directory. */
export async function openPromptMirror(
  ctx: Pick<ToolContext, "stateDir" | "signal">,
  account: string | undefined,
): Promise<Mirror> {
  const stateDir = ctx.stateDir
  if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
  return openMirror(await pickLabel(stateDir, account), ctx.signal)
}

/** The `Reply to` fact of a send's `replyTo`, or undefined when it replies to nothing; a new person has no message to reply to. */
export async function describeReply(
  mirror: Mirror,
  excluded: ReadonlySet<string>,
  chat: string,
  described: DescribedChat,
  replyTo: string | undefined,
): Promise<CallFact | undefined> {
  if (replyTo === undefined) return undefined
  if (described.isNew) throw nothingToQuote()
  return replyFact(mirror, excluded, chat, replyTo)
}

/**
 * The `Reply to` fact of a message of the chat: who wrote it and when. The quoted text is never shown. A message
 * wacli files under an `excluded` chat is not found.
 */
export async function replyFact(
  mirror: Mirror,
  excluded: ReadonlySet<string>,
  chat: string,
  replyTo: string,
): Promise<CallFact> {
  const row = await findMessageRow(mirror, excluded, chat, replyTo)
  if (!row) throw new ToolError("not_found", "No message with this id in this chat to reply to.")
  const time = promptTime(Date.parse(row.Timestamp))
  const value: CallValue = row.FromMe
    ? { text: MESSAGE_WORDS.replyFromMe, values: { time } }
    : {
        text: MESSAGE_WORDS.replyFrom,
        values: { sender: chatDisplayName(row.SenderJID, row.SenderName), time },
      }
  return { label: MESSAGE_WORDS.replyLabel, value }
}
