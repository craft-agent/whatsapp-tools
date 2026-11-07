import type { MessageKind } from "./message-schema"
import type { Mirror } from "./mirror"
import { messageSecond, type WacliMessage } from "./rows"

/** What wacli writes as the text of a poll: this, then the question. */
const POLL_PREFIX = "Poll: "

/** What wacli writes as the text of a vote on a poll, and of an option added to one. */
const POLL_VOTE_TEXT = "Poll vote"
const POLL_OPTION_ADDED_TEXT = "Poll option added"

/** How a call row's display text opens and what it holds: `WhatsApp audio call connected (1m01s)`. */
const CALL_PREFIX = "WhatsApp "
const CALL_WORD = " call"

/** A second either side of the messages, since wacli's bounds exclude the second they name. */
const WINDOW_PADDING_SECONDS = 1

/** The polls and calls among the messages read, which only wacli's own records of them can tell. */
export type MessageKinds = {
  /** The question of each poll, by the id of its message. */
  polls: ReadonlyMap<string, string>
  /** The ids of the messages that hold a call. */
  calls: ReadonlySet<string>
}

/** Whether the row has the text of a poll, which wacli's list of polls then confirms. */
function looksLikePoll(row: WacliMessage): boolean {
  return row.MediaType === "" && row.Text.startsWith(POLL_PREFIX)
}

/** Whether the row has the display text of a call, which wacli's list of calls then confirms. */
function looksLikeCall(row: WacliMessage): boolean {
  return row.DisplayText.startsWith(CALL_PREFIX) && row.DisplayText.includes(CALL_WORD)
}

/**
 * Asks wacli which of `rows`, all of one chat, are polls and calls. A row only counts when wacli's list holds its
 * id; one that merely reads like a poll or a call is asked about, never believed, and a page with none costs no
 * extra read.
 */
export async function readKinds(mirror: Mirror, chat: string, rows: readonly WacliMessage[]): Promise<MessageKinds> {
  const calls = rows.filter(looksLikeCall)
  const seconds = calls.map(messageSecond)
  return {
    polls: rows.some(looksLikePoll) ? await mirror.polls(chat) : new Map(),
    calls:
      calls.length > 0
        ? await mirror.calls(
            chat,
            Math.min(...seconds) - WINDOW_PADDING_SECONDS,
            Math.max(...seconds) + WINDOW_PADDING_SECONDS,
          )
        : new Set(),
  }
}

/** The kind of a message, or undefined for an ordinary one. Votes carry no id of their own, only wacli's fixed text. */
export function messageKind(row: WacliMessage, kinds: MessageKinds): MessageKind | undefined {
  if (kinds.polls.has(row.MsgID)) return "poll"
  if (kinds.calls.has(row.MsgID)) return "call"
  if (row.MediaType !== "") return undefined
  if (row.Text === POLL_VOTE_TEXT) return "poll_vote"
  if (row.Text === POLL_OPTION_ADDED_TEXT) return "poll_option_added"
  return undefined
}
