/**
 * The mirror of the fake wacli (`wacli.fake.cjs`): the reads of `chats`, `messages`, `polls` and `calls` answered
 * from `fake.json`'s `mirror`, in wacli's own JSON shapes and as wacli v0.26 orders and bounds them:
 * `{ "chats": [ { jid, kind, name, last_message_ts, archived, pinned, muted_until, unread, unread_count } ],
 *    "messages": [ { ChatJID, MsgID, Timestamp, … } ], "polls": [ { chat_jid, msg_id, question, … } ],
 *    "calls": [ { chat_jid, msg_id, timestamp, … } ] }`
 *
 * - `chats list [--query q] [--unread] [--limit n]`: pinned first, then the latest message first; a limit of 0 or
 *   less means 50; `null` data for no chat.
 * - `chats show --jid j`: one chat, else the error wacli prints for a missing one.
 * - `messages list [--chat j] [--after t] [--before t] [--limit n] [--asc]`: newest first by second, then by the
 *   order the messages are listed in (wacli's row id); `--after` and `--before` exclusive, in whole seconds; a
 *   limit of 0 or less means 50. Like wacli's cursorless read, and unlike its store, it keeps deleted rows.
 * - `polls list [--chat j] [--limit n]`: a limit of 0 means every poll.
 * - `calls list [--chat j] [--after t] [--before t] [--limit n] [--asc]`: ordered like messages, by `timestamp`.
 */
"use strict"

const DEFAULT_LIMIT = 50
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

/** The rows within the exclusive bounds `--after` and `--before` in whole seconds, newest first unless `--asc`. */
function window(args, rows, timeOf) {
  const after = flagValue(args, "--after")
  const before = flagValue(args, "--before")
  const chat = flagValue(args, "--chat")
  const kept = rows
    .map((row, order) => ({ row, order, second: secondOf(timeOf(row)) }))
    .filter(({ row }) => chat === undefined || (row.ChatJID ?? row.chat_jid) === chat)
    .filter(
      ({ second }) =>
        (after === undefined || second > secondOf(after)) && (before === undefined || second < secondOf(before)),
    )
  const direction = args.includes("--asc") ? 1 : -1
  kept.sort((a, b) => direction * (a.second - b.second || a.order - b.order))
  return kept.slice(0, limitOf(args)).map(({ row }) => row)
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
