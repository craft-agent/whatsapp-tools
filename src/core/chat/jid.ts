import { ToolError } from "../errors"

/** The kinds of chat a result names. */
export const CHAT_KINDS = ["person", "group", "broadcast", "channel", "unknown"] as const

/** One kind of chat a result names. */
export type ChatKind = (typeof CHAT_KINDS)[number]

/** The server of a JID that carries a phone number. */
const PHONE_SERVER = "s.whatsapp.net"

/** A person's JID: digits, and the number of the device they write from, which names no other chat. */
const PHONE_JID = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/

/** The other JIDs a chat has: a hidden-number contact, a group, a channel and a broadcast list. */
const OTHER_JIDS: readonly RegExp[] = [/^\d+@lid$/, /^\d+(?:-\d+)?@g\.us$/, /^\w+@newsletter$/, /^[\w-]+@broadcast$/]

/** wacli's names for the kinds of chat, and the kinds a result calls them. */
const KINDS: ReadonlyMap<string, ChatKind> = new Map<string, ChatKind>([
  ["dm", "person"],
  ["group", "group"],
  ["broadcast", "broadcast"],
  ["newsletter", "channel"],
])

/**
 * The chat JID `text` names, with a person's device suffix removed, or `invalid_argument` saying that a chat is a
 * JID and where to find it (`finder` names what lists the chats, `list` for a method of the chat tool). The text is
 * not echoed, since it may be a number.
 */
export function parseChatJid(text: string | undefined, name: string, method: string, finder = "list"): string {
  const jid = text?.trim()
  const phone = jid === undefined ? null : PHONE_JID.exec(jid)
  if (phone) return `${phone[1]}@${PHONE_SERVER}`
  if (jid !== undefined && OTHER_JIDS.some((form) => form.test(jid))) return jid
  throw new ToolError(
    "invalid_argument",
    `${name} ${text === undefined ? `is required for ${method}` : "must be a chat JID"}: …@s.whatsapp.net, …@lid, …@g.us, …@newsletter or …@broadcast, never a name or a number. Use ${finder} to find the chat's JID.`,
  )
}

/**
 * The kinds a JID's server alone tells, for a chat wacli names no kind of. A broadcast JID is left out: the status
 * feed (`status@broadcast`) is one too, and it is not a broadcast list.
 */
const SERVER_KINDS: ReadonlyMap<string, ChatKind> = new Map<string, ChatKind>([
  ["s.whatsapp.net", "person"],
  ["lid", "person"],
  ["g.us", "group"],
  ["newsletter", "channel"],
])

/**
 * The kind of chat that wacli's `kind` names. When wacli names none it knows, which it does for a hidden-number
 * contact it cannot tie to a number, the server of the chat's `jid` decides; anything else is `unknown`.
 */
export function chatKind(wacliKind: string, jid: string): ChatKind {
  return KINDS.get(wacliKind) ?? SERVER_KINDS.get(jid.slice(jid.lastIndexOf("@") + 1)) ?? "unknown"
}

/** A person's number as `+digits`, only from a JID that carries one; a hidden-number JID has none. */
export function chatNumber(jid: string): string | undefined {
  const phone = PHONE_JID.exec(jid)
  return phone ? `+${phone[1]}` : undefined
}
