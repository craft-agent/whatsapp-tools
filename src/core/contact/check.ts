import { ToolError } from "../errors"
import type { LabelPaths } from "../whatsapp/labels"
import {
  CHECKED_NUMBER,
  CONTACTS_CHECK_OP,
  CONTACTS_CHECK_TIMEOUT_MS,
  MAX_CHECKED_NUMBERS,
  checkResults,
  type CheckedNumber,
} from "../whatsapp/operations"
import { callService } from "../whatsapp/service-client"
import { CHECK_NOTE, type CheckEntry, type ContactReadInput, type ContactReadOutput } from "./schema"

/** What is removed from a number as typed: spaces, dots, dashes and brackets. */
const SEPARATORS = /[\s.()[\]-]/g

/** The server of a person's phone JID, which names the chat wacli files their messages under. */
const PERSON_SERVER = "s.whatsapp.net"

const NUMBER_FORM = "+ and 7 to 15 digits, the first not 0 (the country code, then the number)"

/**
 * The numbers to ask about: separators removed, each checked against the form WhatsApp takes, duplicates merged in
 * the order first given. `invalid_argument` names the entry at fault without echoing it.
 */
export function readNumbers(given: string[] | undefined): string[] {
  if (given === undefined || given.length === 0) {
    throw new ToolError("invalid_argument", `numbers is required for check: 1 to ${MAX_CHECKED_NUMBERS} numbers.`)
  }
  if (given.length > MAX_CHECKED_NUMBERS) {
    throw new ToolError(
      "invalid_argument",
      `Check at most ${MAX_CHECKED_NUMBERS} numbers at once: looking up many numbers at once gets an account limited by WhatsApp. Check the rest in a later call.`,
    )
  }
  const numbers = given.map((entry, index) => {
    const number = entry.replace(SEPARATORS, "")
    if (!CHECKED_NUMBER.test(number)) {
      throw new ToolError("invalid_argument", `numbers entry ${index + 1} must be ${NUMBER_FORM}.`)
    }
    return number
  })
  return [...new Set(numbers)]
}

/** The digits of a number, which is how wacli names a phone. */
function digitsOf(text: string): string {
  return text.replace(/\D/g, "")
}

/**
 * The chat to write to for a number on WhatsApp: the phone JID WhatsApp answers with, which may differ from the
 * number typed, else the number's own. An `…@lid` answer is not passed on, since wacli files the messages of a
 * person whose number it knows under the phone JID.
 */
function chatFor(digits: string, jid: string | undefined): string {
  const answered = jid?.split("@")
  if (answered?.length === 2 && answered[1] === PERSON_SERVER && /^\d+$/.test(answered[0]!)) return jid!
  return `${digits}@${PERSON_SERVER}`
}

/**
 * What the answer says of one number. Only a number WhatsApp answered for can be on WhatsApp or not; one it left
 * out of its answer, or one wacli did not return, is `unknown` and never a no.
 */
function entryFor(number: string, answers: ReadonlyMap<string, CheckedNumber>): CheckEntry {
  const digits = digitsOf(number)
  const answer = answers.get(digits)
  if (!answer?.responded) return { number, status: "unknown" }
  if (!answer.registered) return { number, status: "not_on_whatsapp" }
  return { number, status: "on_whatsapp", chat: chatFor(digits, answer.jid) }
}

/**
 * The `check` method: asks WhatsApp through the label's running sync service which numbers have an account. The
 * service runs the check; this call never runs wacli itself, writes nothing and saves no contact. Without a running
 * service it fails as `upstream_error`, saying to start it.
 */
export async function checkNumbers(
  paths: LabelPaths,
  args: ContactReadInput,
  signal: AbortSignal | undefined,
): Promise<ContactReadOutput> {
  const numbers = readNumbers(args.numbers)
  const data = await callService(
    paths,
    CONTACTS_CHECK_OP,
    { numbers },
    { mode: "ask", timeoutMs: CONTACTS_CHECK_TIMEOUT_MS, signal },
  )
  const results = checkResults.safeParse(data)
  if (!results.success) {
    throw new ToolError("upstream_error", "The sync service returned a number check that cannot be read.")
  }
  const answers = new Map(results.data.map((result) => [digitsOf(result.phone), result]))
  return { numbers: numbers.map((number) => entryFor(number, answers)), note: CHECK_NOTE }
}
