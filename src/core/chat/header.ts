import { chatNumber, type ChatKind } from "./jid"
import type { ChatRef } from "./message-schema"
import { chatNameFields } from "./names"

/** The chat header of a result. */
export function chatHeader(jid: string, kind: ChatKind, name: string): ChatRef {
  const ref: ChatRef = { id: jid, kind, ...chatNameFields(name) }
  const number = chatNumber(jid)
  if (number !== undefined) ref.number = number
  return ref
}
