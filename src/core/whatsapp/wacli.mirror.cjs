/**
 * The mirror of the fake wacli (`wacli.fake.cjs`): the reads of `chats`, `messages`, `polls` and `calls` answered
 * from `fake.json`'s `mirror`, in wacli's own JSON shapes and as wacli v0.26 orders and bounds them:
 * `{ "chats": [ { jid, kind, name, last_message_ts, archived, pinned, muted_until, unread, unread_count } ],
 *    "messages": [ { ChatJID, MsgID, Timestamp, … } ], "polls": [ { chat_jid, msg_id, question, … } ],
 *    "calls": [ { chat_jid, msg_id, timestamp, … } ] }`
 *
 * Its full-text mode only stands in for wacli's ordering: it matches each word as a substring, where FTS5 matches
 * whole tokens or their prefixes, so a test must not rely on a match inside a word.
 *
 * - `chats list [--query q] [--unread] [--limit n]`: pinned first, then the latest message first; a limit of 0 or
 *   less means 50; `null` data for no chat.
 * - `chats show --jid j`: one chat, else the error wacli prints for a missing one.
 * - `messages list [--chat j] [--after t] [--before t] [--limit n] [--asc]`: newest first by second, then by the
 *   order the messages are listed in (wacli's row id); `--after` and `--before` exclusive, in whole seconds; a
 *   limit of 0 or less means 50. Like wacli's cursorless read, and unlike its store, it keeps deleted rows.
 * - `messages search [--chat j] [--after t] [--before t] [--limit n] -- <query>` and
 *   `messages context --chat j --id i [--before n] [--after n]`: see `messagesSearch` and `messagesContext`.
 *   `mirror.relevance` (message ids, best first) switches the search to answer as wacli's full-text search does.
 * - `polls list [--chat j] [--limit n]`: a limit of 0 means every poll.
 * - `calls list [--chat j] [--after t] [--before t] [--limit n] [--asc]`: ordered like messages, by `timestamp`.
 */
"use strict"

const DEFAULT_LIMIT = 50
const DEFAULT_CONTEXT = 5
const MS_PER_SECOND = 1000

/** The value of `--name value` or `--name=value`, else undefined. */
function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1]
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
  }
  return undefined
}

function success(data) {
  return { stdout: `${JSON.stringify({ success: true, data, error: null })}\n` }
}

function failure(text) {
  return { stderr: `${JSON.stringify({ success: false, data: null, error: text })}\n`, exit: 1 }
}

function limitOf(args, fallback = DEFAULT_LIMIT) {
  const value = Number(flagValue(args, "--limit") ?? fallback)
  return value <= 0 ? DEFAULT_LIMIT : value
}

function secondOf(text) {
  return Math.floor(Date.parse(text) / MS_PER_SECOND)
}

/** The rows within the exclusive bounds `--after` and `--before` in whole seconds, with their arrival order. */
function within(args, rows, timeOf) {
  const after = flagValue(args, "--after")
  const before = flagValue(args, "--before")
  const chat = flagValue(args, "--chat")
  const afterSecond = after === undefined ? undefined : secondOf(after)
  const beforeSecond = before === undefined ? undefined : secondOf(before)
  return rows
    .map((row, order) => ({ row, order, second: secondOf(timeOf(row)) }))
    .filter(({ row }) => chat === undefined || (row.ChatJID ?? row.chat_jid) === chat)
    .filter(
      ({ second }) =>
        (afterSecond === undefined || second > afterSecond) && (beforeSecond === undefined || second < beforeSecond),
    )
}

/** The rows within the bounds, newest first unless `--asc`, at most `--limit` of them. */
function window(args, rows, timeOf) {
  const kept = within(args, rows, timeOf)
  const direction = args.includes("--asc") ? 1 : -1
  kept.sort((a, b) => direction * (a.second - b.second || a.order - b.order))
  return kept.slice(0, limitOf(args)).map(({ row }) => row)
}

/** Whether a message holds `needle` (lower case) in a field wacli's search looks through. */
function holds(message, chats, needle) {
  const chat = chats.find((candidate) => candidate.jid === message.ChatJID)
  return [
    message.Text,
    message.DisplayText,
    message.MediaCaption,
    message.Filename,
    message.ChatName,
    message.SenderName,
    chat?.name,
  ].some((field) => (field ?? "").toLowerCase().includes(needle))
}

/**
 * `messages search [--chat j] [--after t] [--before t] [--limit n] -- <query>`: the messages that hold the query,
 * case folded, in one of the fields wacli matches (text, display text, caption, file name, sender and chat names).
 * Without `mirror.relevance` it answers as wacli's LIKE search does: the whole query as text, newest first by second
 * and then by arrival, `fts: false`. With it (a list of message ids, best match first) it answers as the full-text
 * search does: every word of the query must match, the listed messages come in that order and the rest after them,
 * `fts: true`. `has_more` says there were more hits than the limit.
 */
function messagesSearch(args, mirror) {
  const { messages = [], chats = [], relevance } = mirror
  const dash = args.indexOf("--")
  const flags = dash < 0 ? args : args.slice(0, dash)
  const query = dash < 0 ? "" : (args[dash + 1] ?? "")
  if (query.trim() === "") return failure("query is required")
  const needles = relevance ? query.toLowerCase().split(/\s+/).filter(Boolean) : [query.toLowerCase()]
  const relevanceMap = relevance ? new Map(relevance.map((id, index) => [id, index])) : null
  const rank = (message) => {
    if (!relevanceMap) return 0
    const place = relevanceMap.get(message.MsgID)
    return place === undefined ? relevance.length : place
  }
  const hits = within(flags, messages, (row) => row.Timestamp)
    .filter(({ row }) => !row.deleted_at && needles.every((needle) => holds(row, chats, needle)))
    .sort((a, b) => rank(a.row) - rank(b.row) || b.second - a.second || b.order - a.order)
  const limit = limitOf(flags)
  return success({
    messages: hits.length > 0 ? hits.slice(0, limit).map(({ row }) => row) : null,
    fts: relevance !== undefined,
    page: { has_more: hits.length > limit, next_cursor: null },
    source: { last_sync_at: null, scope: "local_archive" },
  })
}

/**
 * `messages context --chat j --id i [--before n] [--after n]`: the message and up to n rows before and after it in
 * the chat (by second, then arrival), oldest first, as a bare list; the rows that hold nothing readable included.
 * A message the chat does not have fails as wacli does.
 */
function messagesContext(args, messages) {
  const chat = flagValue(args, "--chat")
  const id = flagValue(args, "--id")
  const rows = messages
    .map((row, order) => ({ row, order, second: secondOf(row.Timestamp) }))
    .filter(({ row }) => row.ChatJID === chat)
    .sort((a, b) => a.second - b.second || a.order - b.order)
  const index = rows.findIndex(({ row }) => row.MsgID === id)
  if (index < 0) return failure("sql: no rows in result set")
  const before = Number(flagValue(args, "--before") ?? DEFAULT_CONTEXT)
  const after = Number(flagValue(args, "--after") ?? DEFAULT_CONTEXT)
  return success(rows.slice(Math.max(0, index - before), index + after + 1).map(({ row }) => row))
}

function chatsList(args, chats) {
  const query = (flagValue(args, "--query") ?? "").toLowerCase()
  const unread = args.includes("--unread")
  const kept = chats
    .filter((chat) => query === "" || chat.name.toLowerCase().includes(query) || chat.jid.toLowerCase().includes(query))
    .filter((chat) => !unread || chat.unread)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.last_message_ts < b.last_message_ts ? 1 : -1))
  const page = kept.slice(0, limitOf(args))
  return success(page.length > 0 ? page : null)
}

/**
 * The answer for `args` (the command line without the global flags) from `mirror`, as `{ stdout?, stderr?, exit? }`,
 * or undefined when the command is not one of the mirror's reads.
 */
function answer(args, mirror) {
  const command = `${args[0]} ${args[1]}`
  const { chats = [], messages = [], polls = [], calls = [] } = mirror
  switch (command) {
    case "chats list":
      return chatsList(args, chats)
    case "chats show": {
      const chat = chats.find((candidate) => candidate.jid === flagValue(args, "--jid"))
      return chat ? success(chat) : failure("sql: no rows in result set")
    }
    case "messages list": {
      const page = window(args, messages, (row) => row.Timestamp)
      return success({
        messages: page.length > 0 ? page : null,
        fts: false,
        page: { has_more: false, next_cursor: null },
        source: { last_sync_at: null, scope: "local_archive" },
      })
    }
    case "messages search":
      return messagesSearch(args, mirror)
    case "messages context":
      return messagesContext(args, messages)
    case "polls list": {
      const chat = flagValue(args, "--chat")
      const kept = polls.filter((poll) => chat === undefined || poll.chat_jid === chat)
      const limit = Number(flagValue(args, "--limit") ?? DEFAULT_LIMIT)
      return success({ polls: limit === 0 ? kept : kept.slice(0, limit) })
    }
    case "calls list": {
      const page = window(args, calls, (row) => row.timestamp)
      return success({ calls: page.length > 0 ? page : null })
    }
    default:
      return undefined
  }
}

module.exports = { answer }
