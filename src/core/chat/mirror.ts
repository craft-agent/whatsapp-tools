import { env } from "node:process"
import { z } from "zod"
import { ToolError } from "../errors"
import { MS_PER_SECOND } from "../time"
import type { LabelPaths } from "../whatsapp/labels"
import { runWacli } from "../whatsapp/wacli"
import {
  wacliCall,
  wacliChat,
  wacliHit,
  wacliMessage,
  wacliPoll,
  wacliSearchPage,
  type WacliChat,
  type WacliHit,
  type WacliMessage,
} from "./rows"

/** The most chats one `chats list` read returns, which is more than any account holds. */
const CHATS_LIMIT = 1_000_000

/** The most call events one read of a window returns. */
const CALLS_LIMIT = 1000

/** wacli's `--limit` for every poll of a chat. */
const ALL_POLLS = 0

/** The latest second a time can name in RFC 3339 with four digits of year. */
const MAX_SECOND = 253_402_300_799

/** The text wacli's error carries when `chats show` or `messages context` finds no such row. */
const NO_ROWS = /no rows in result set/i

/** Which messages of a chat to read: the newest `limit`, between two exclusive bounds in whole seconds. */
export type MessageQuery = { chat: string; limit: number; afterSecond?: number; beforeSecond?: number }

/** Which messages to search for: at most `limit` hits of the text, in one chat or all, between two exclusive bounds in whole seconds. */
export type SearchQuery = { text: string; chat?: string; limit: number; afterSecond?: number; beforeSecond?: number }

/** What a search found. */
export type SearchHits = {
  /** The hits wacli returned, in its own order. */
  hits: WacliHit[]
  /** Whether wacli ranked them by relevance (full-text search) rather than newest first (a plain match). */
  ranked: boolean
  /** Whether wacli held more hits than `limit`. */
  more: boolean
}

/** What the tool reads of one account's mirror, through wacli's own reads. */
export type Mirror = {
  /** The label of the account it belongs to, which a cursor is bound to. */
  readonly label: string
  /** Every chat that matches, in wacli's order; `pinned` keeps only the pinned ones. */
  chats(filter: { query?: string; unread?: boolean; pinned?: boolean }): Promise<WacliChat[]>
  /** One chat, or `not_found`. */
  chat(jid: string): Promise<WacliChat>
  /** The newest messages of a chat first, bounded in whole seconds (exclusive). */
  messages(query: MessageQuery): Promise<WacliMessage[]>
  /** The messages whose text, captions, file names or names hold `text`, in wacli's order. */
  search(query: SearchQuery): Promise<SearchHits>
  /**
   * The rows around a message of a chat, oldest first, the message itself among them: up to `before` rows before it
   * and `after` after it, the unreadable ones included. `not_found` when the chat has no such message.
   */
  context(chat: string, id: string, before: number, after: number): Promise<WacliMessage[]>
  /** The polls of a chat: the questions by the id of the message that holds each. */
  polls(chat: string): Promise<Map<string, string>>
  /** The ids of the messages of a chat that hold a call, among the call events between two seconds (exclusive). */
  calls(chat: string, afterSecond: number, beforeSecond: number): Promise<Set<string>>
}

/** A Unix second as the RFC 3339 time wacli reads, kept inside the years it can write. */
function wacliTime(second: number): string {
  const clamped = Math.min(Math.max(second, 0), MAX_SECOND)
  return new Date(clamped * MS_PER_SECOND).toISOString().replace(".000Z", "Z")
}

function parse<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new ToolError("upstream_error", `wacli returned ${what} that cannot be read.`)
  return parsed.data
}

/** The list at `key` of the object wacli printed; wacli prints `null` for an empty one. */
function listAt(data: unknown, key: string, what: string): unknown[] {
  return parse(z.object({ [key]: z.array(z.unknown()).nullable() }), data, what)[key] ?? []
}

/** What a read says of a chat the mirror does not hold, which an excluded chat is told as. */
export const NO_SUCH_CHAT = "No chat with this JID in this account's mirror. Use list to find the chat's JID."

/** What `read` returns, or `not_found` saying `message` when wacli answered that it has no such row. */
async function orNotFound<T>(read: () => Promise<T>, message: string): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof ToolError && error.code === "upstream_error" && NO_ROWS.test(error.message)) {
      throw new ToolError("not_found", message)
    }
    throw error
  }
}

/** The mirror of one account, read with `wacli --read-only`; an abort of `signal` ends the call under way. */
export function openMirror(paths: LabelPaths, signal: AbortSignal | undefined): Mirror {
  const read = (args: string[]) => runWacli(paths, args, { env, mode: "read", signal })
  return {
    label: paths.label,
    async chats({ query, unread, pinned }) {
      const args = ["chats", "list", "--limit", String(CHATS_LIMIT)]
      if (query) args.push(`--query=${query}`)
      if (unread) args.push("--unread")
      if (pinned) args.push("--pinned")
      return parse(z.array(wacliChat).nullable(), await read(args), "a chat list") ?? []
    },
    async chat(jid) {
      return orNotFound(
        async () => parse(wacliChat, await read(["chats", "show", "--jid", jid]), "a chat"),
        NO_SUCH_CHAT,
      )
    },
    async messages({ chat, limit, afterSecond, beforeSecond }) {
      const args = ["messages", "list", "--chat", chat, "--limit", String(limit)]
      if (afterSecond !== undefined) args.push("--after", wacliTime(afterSecond))
      if (beforeSecond !== undefined) args.push("--before", wacliTime(beforeSecond))
      return listAt(await read(args), "messages", "a message list").map((row) => parse(wacliMessage, row, "a message"))
    },
    async search({ text, chat, limit, afterSecond, beforeSecond }) {
      const args = ["messages", "search", "--limit", String(limit)]
      if (chat !== undefined) args.push("--chat", chat)
      if (afterSecond !== undefined) args.push("--after", wacliTime(afterSecond))
      if (beforeSecond !== undefined) args.push("--before", wacliTime(beforeSecond))
      // After `--`, so that a text starting with `-` is the text and not a flag.
      args.push("--", text)
      const page = parse(wacliSearchPage, await read(args), "a search result")
      const hits = (page.messages ?? []).map((row) => parse(wacliHit, row, "a message"))
      return { hits, ranked: page.fts, more: page.page.has_more }
    },
    async context(chat, id, before, after) {
      const args = [
        "messages",
        "context",
        "--chat",
        chat,
        `--id=${id}`,
        "--before",
        String(before),
        "--after",
        String(after),
      ]
      return orNotFound(
        async () => parse(z.array(wacliMessage), await read(args), "a message context"),
        "No message with this id in this chat.",
      )
    },
    async polls(chat) {
      const data = await read(["polls", "list", "--chat", chat, "--limit", String(ALL_POLLS)])
      const polls = listAt(data, "polls", "a poll list").map((row) => parse(wacliPoll, row, "a poll"))
      return new Map(polls.map((poll) => [poll.msg_id, poll.question]))
    },
    async calls(chat, afterSecond, beforeSecond) {
      const args = ["calls", "list", "--chat", chat, "--limit", String(CALLS_LIMIT)]
      args.push("--after", wacliTime(afterSecond), "--before", wacliTime(beforeSecond))
      const calls = listAt(await read(args), "calls", "a call list").map((row) => parse(wacliCall, row, "a call"))
      return new Set(calls.map((call) => call.msg_id).filter((id) => id !== ""))
    },
  }
}
