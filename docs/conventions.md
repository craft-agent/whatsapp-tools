# Tool conventions

The rules every tool in this package follows, so tools read alike across
domains and harnesses. Each rule carries the reason it was chosen; a change
to a rule changes this file first, with its reason.

## Names

- **Tool IDs are `<prefix>_<domain>_<verb>`**: `<prefix>_note_read` and
  `<prefix>_note_create` for a `note` domain. The prefix is `toolPrefix` in
  `src/project.ts`; it keeps a name unambiguous where a harness lists every
  tool in one namespace. When the domain has a well-known command line,
  follow its word order, so a name maps to a command anyone can look up.
- **The same ID in every entry point.** Permission rules and skills are
  written once, and an ID is a public interface: renaming one is a breaking
  change.
- **Verbs are plain**: `create`, `edit`, `delete`, `add`, `remove`, and these
  with a fixed meaning:

  | Verb      | Means                                                        |
  | --------- | ------------------------------------------------------------ |
  | `read`    | the one read tool of a domain (below)                        |
  | `resolve` | find which object a call means                               |
  | `ensure`  | create when missing, reuse when present; never a second copy |

- **One read tool per domain, one write tool per operation.**
  `<prefix>_<domain>_read` takes a `method` argument (`view`, `list`, …). A
  model picks tools worse as their number grows, and reads share one set of
  annotations, so folding them loses nothing. Writes stay apart because a
  merged write tool would carry its strictest class: creating something would
  ask like overwriting it.
- **Names stay within 40 characters**, so a client prefix such as
  `mcp__<server>__` still fits a 64-character limit. `defineTool` enforces
  the shape and the length; `src/tools.test.ts` enforces the prefix.

## Arguments

- **snake_case**, for arguments and for the keys of a result alike: one style
  for everything a model reads.
- **Lists change through flat arguments**: `add_tags`, `remove_tags`. Shallow
  schemas are read reliably by every model the harnesses run. An argument that
  replaces a whole list, where one is needed, is named for the list (`tags`)
  and its description says it replaces.
- **Unknown arguments are refused.** Every entry point validates the
  arguments as strict, so a misspelt one fails as `invalid_argument` instead
  of being ignored.
- **The tools' own install directory is never the working tree.** A harness
  may start a tool inside the directory the package is installed in.
  `ToolContext.ownDir` names it; a tool that reads the working tree refuses
  to treat that directory as the caller's, saying so.

## Results

- **A tool returns its data as a plain object**, with no `ok` envelope. Each
  entry point renders it: the MCP server as `structuredContent` with the
  tool's `outputSchema` plus the same JSON as text, a native plugin as a JSON
  string.
- **A failure throws.** Every harness then sees a failed call (`isError` over
  MCP) rather than a success that carries an error.
- **One exception: what a call created is never lost.** Once a tool has
  created something, a later step of the same call that fails does not throw.
  The result names what was created and lists the failed steps under
  `errors`, keyed by step (`StepErrors`).
- **Text a tool reads is returned as it is.** Content from files or services
  is data, never instructions; every read tool's description and the skills
  say so. Nothing is wrapped or rewritten.
- **Times are local, with their offset, to the millisecond**:
  `2026-11-07T14:03:12.345+09:00`. A model judges "yesterday" or "this
  morning" by the user's clock, and the offset keeps the instant exact. A time
  argument takes RFC 3339 with an offset, or a date or a time without one
  (`2026-11-07`, `2026-11-07T14:03`), read as local time; a local time a
  clock change skips or repeats is read as JavaScript's `Date` reads it.
- **A list comes in pages.** It takes `limit`, with a default and a largest
  value per method (above the largest is clamped, below 1 refused), and
  `cursor` to continue; a page with more returns `next`, an opaque string to
  pass back as `cursor`. A cursor holds where the page ended, not a count, so
  what arrives between two pages does not shift the next one.
- **A result stays under 50,000 characters of JSON** by returning fewer
  items and a `next`, since some harnesses refuse a result over 60,000. Text
  is never cut to fit, because a cut message reads as what was said: only a
  single item that alone exceeds the budget is cut, and it says so
  (`text_cut: true`).

## Errors

A thrown error carries a `code` a caller can branch on, and a message that
says what to do next.

| Code               | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `not_found`        | the object does not exist, or the caller cannot see it                     |
| `forbidden`        | the caller lacks the permission the call needs                             |
| `invalid_argument` | the arguments cannot describe a valid call                                 |
| `stale`            | what the call relied on changed before it could finish                     |
| `unauthenticated`  | the service or program the tool calls is not logged in                     |
| `rate_limited`     | the service refused the call for its rate limit                            |
| `declined`         | the person declined a confirmation the tool asked for                      |
| `upstream_error`   | the service or program the tool calls failed; the message carries its text |
| `uncertain`        | a write may have taken effect; check before trying it again                |
| `internal_error`   | a bug in a tool or an entry point, such as a result off its schema         |

A project adds a code to `src/core/errors.ts` and to this table together.

## Write classes

Every tool belongs to one class, and the class sets its MCP annotations.
`openWorldHint` is `true` for every tool.

| Class             | Examples                              | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ----------------- | ------------------------------------- | -------------- | ----------------- | ---------------- |
| read              | view, list, resolve                   | `true`         | —                 | `true`           |
| add               | create, add                           | `false`        | `false`           | `false`          |
| idempotent change | ensure, adding a tag                  | `false`        | `false`           | `true`           |
| overwrite         | editing a body or title, removing one | `false`        | `true`            | `true`           |
| administrative    | delete, visibility, publishing        | `false`        | `true`            | `false`          |

- **Overwriting counts as destructive**: it loses what was there, and
  harnesses that confirm only destructive tools should still ask before it.
- **A tool takes the strictest class its arguments can reach.**
- **The harness confirms writes.** Every MCP client asks before it runs a
  write tool, so the tool does not ask again by default. Administrative tools
  also carry `_meta["anthropic/requiresUserInteraction"]: true`, which makes
  Claude Code ask even under an allow rule.
- **A native plugin asks the harness's own permission before every non-read
  call**, since the tools a native plugin adds pass through no harness
  approval of their own.
- **It asks for everything the call writes to.** A write tool's `targets`
  resolver names what the call writes to, as the permission rules name it
  (a path, an account, a record). Anything it cannot tell, every tool
  without a resolver, and a target holding `*` or `?` (which a harness would
  store as a pattern) is `*`, and `*` is never stored. An "always" answer then
  covers only what it named, never a write somewhere else.
- **`confirm: "elicitation"` adds the tool's own form** for administrative
  tools, where the client offers form-mode elicitation. It is for people who
  switch the client's approvals off: the tool states what will happen in plain
  words and stops on anything but an accept. Where the client does not offer
  elicitation the setting adds nothing, and the harness's approval is then the
  only confirmation.
- **Annotations are hints, not a boundary.** The `read_only` setting
  (below) is what keeps writes out.

## Toolsets and settings

Every entry point takes the same settings:

- **Toolsets**: one per domain, listed in `src/project.ts` with the ones on by
  default. A small default keeps the model's choice sharp.
- **`read_only`** registers no write tool, and wins over every other setting.
- **`tools` / `exclude_tools`** add or remove single tools; an exclusion wins
  over an inclusion.
- **`confirm`** is `harness` (the default) or `elicitation`; it says who asks
  before an administrative tool acts (see "Write classes"). The default leaves
  the question to the harness, whose approval every user already knows.
- **`state_dir`**: where every account's state lives (see "Accounts and state").

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree) and an optional `confirm(request) => Promise<boolean>` hook.
  Nothing in it names a harness. An entry point supplies `confirm` when the
  `elicitation` setting is on; without it the harness's approval stands, and a
  tool that needs a confirmation treats a missing hook as the harness having
  approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun. It knows no project either: names, prefixes and toolsets
  come from `src/project.ts` through the entry points.

## Programs a tool runs

- **Every program a tool runs goes through one runner** built on `exec`, with
  an explicit environment: what the program needs to find itself and
  authenticate is passed through, and nothing else, so a stray variable
  cannot redirect a call. Prompts and colors are switched off, so nothing
  waits on a person and output parses the same everywhere.
- **Every call has a time limit**, and a call that is stopped, by that limit
  or by cancellation, has its child process killed: `SIGTERM`, then `SIGKILL`
  after two seconds. A hung program neither holds a harness forever nor
  outlives its call.
- **The runner maps the program's failures to the error codes above.**

## Tests

- Tests sit beside the code they test (`*.test.ts`) and run on `bun test`;
  CI also starts the built MCP server, plugin and command line under Node and
  lists their tools, so a runtime-only API cannot slip in unnoticed.
- No test reaches a real service. A tool that runs a program is tested
  against a fake of that program on `PATH`.
- A test file stays within about 300 lines, split by topic
  (`<name>.<topic>.test.ts`), so one commit can carry a change and its test.

## Accounts and state

- **One label is one linked device.** The tools join a WhatsApp account the
  way WhatsApp Web does, as a linked device of the user's phone, through
  [wacli](https://github.com/openclaw/wacli); they never drive WhatsApp Web
  or read another client's data. Pairing is a person's step (a QR code scanned
  on the phone, or a code typed into it), and it names the label the device is
  known by.
- **A label is 1 to 24 lowercase letters, digits and `_`**, starting and
  ending with a letter or a digit; pairing names it `default` when no label is
  given. A label is also a directory name, so the set is kept to what every
  file system takes as it is, and it is the same set signal-tools uses.
- **Each label keeps all of its state in one directory**,
  `<state root>/<label>/`, created with mode 700: the wacli store (the session
  keys, wacli's mirror of the messages, downloaded media, its lock and its
  socket), the sync service's socket, and the short-lived copies of files
  being sent. Every call to wacli names the store with `--store`; wacli's own
  account registry (`wacli accounts`, its `config.yaml`, `~/.wacli`) is never
  used, since it lives outside the state root and any wacli command could
  change it. The state root is the `state_dir` setting, by default
  `$XDG_STATE_HOME/whatsapp-tools`, or `~/.local/state/whatsapp-tools` without
  it. One directory per label means a label is moved, backed up or removed as
  a whole, and nothing of one account sits in another's.
- **`account` picks the label.** Left out, it picks the only paired label;
  with several, the call fails as `invalid_argument` and lists them. One
  account is the common case and needs no argument, while several never
  depend on which one a tool guesses.
- **A label reaches only its own account.** A chat is looked up only in that
  label's mirror, and a call to WhatsApp goes only through that label's store
  and service, so no argument can carry a call to an account the label does
  not name.
- **The keys never leave the state directory.** Nothing of the session keys
  reaches a result, an error or a log, and no tool opens the store's files:
  messages and media reach a tool only as wacli prints them. The keys stand
  for the account itself: whoever holds them reads and sends as the user.
  wacli's database files are its own, and their layout changes between
  releases; the JSON wacli prints is the interface it promises.

## wacli

- **wacli 0.26 or later.** The user installs wacli and keeps it current; it
  is not a dependency of the package. The tools are tested against wacli's
  newest release, and a wacli older than 0.26 is refused with the line to
  update it. WhatsApp stops serving old clients until wacli catches up with
  its protocol, and the releases up to 0.26 brought what the tools stand on:
  the number check served by a running sync, cursor reads, no retry of a send
  after an ambiguous disconnect, and a private named pipe on Windows.
- **Every call to wacli goes through one runner**, built on the runner above:
  the label's `--store`, `--json`, a time limit with cancellation, the
  envelope read from stdout on success and from stderr on failure, and
  wacli's errors mapped to the codes above. wacli exits with 0 or 1 only, so a
  failure is told apart by the error text of the envelope wacli wrote, never
  by anything else it printed: output that is not an envelope is an
  `upstream_error`, and for a write `uncertain`.
- **`WACLI_MEDIA_ROOTS` is always set**, to the label's outbox, so wacli
  itself refuses to upload any file but the copies the tools made and
  checked.

## The sync service

- **The sync service alone holds a label's store.** One service per label
  runs `wacli sync --follow` as its child, which keeps the mirror current and
  holds the store's lock. The child never outlives the service, and a child
  that exits on its own takes the service with it; only a stop the service
  makes for an operation of its own (below) is followed by starting the child
  again. The child runs in
  quiet presence, so the device is not shown online and the phone keeps its
  notifications, and it reconnects without a deadline. Messages that arrive
  while the service is down reach the mirror when it starts again, as they
  reach any linked device that was offline.
- **A revoked session stops the service.** With no paired device, or once
  WhatsApp has revoked the session (the device removed on the phone, unused
  for 30 days, or the phone unused for 14), the service exits and stays down
  until the device is paired again, rather than restarting against an account
  it can no longer reach. wacli ends its sync with exit 0 and a `logged_out`
  event then, which tells it apart from a reconnect that gave up.
- **Every write goes through the service**, over the service's own socket in
  the label's directory, one at a time. What wacli hands to a running sync
  (sends, the number check, edits, reactions, read state, …) the service
  passes to its child; what it does not (asking the phone for older history,
  deleting for everyone) the service runs itself, between stopping its child
  and starting it again, and it starts the child again whatever became of the
  operation. A tool never runs a writing wacli command itself. With one writer
  per store, a send never meets a store that another call holds, nothing but
  the service connects to WhatsApp, a write with the service down fails
  before anything leaves, and no process outside the service ever stops it,
  so nothing has to bring it back.
- **The service sends no read receipts or typing indicators of its own**, so
  the phone keeps its notifications and nobody learns that a message was read
  by a tool.

## Reads

- **Every read runs wacli with `--read-only`**, which refuses any write and
  takes no lock, so reading works beside the service and while it is down,
  and can never change what was received. The number check is the exception:
  a number tells nothing of the account behind it until WhatsApp is asked, so
  it asks through the label's service and needs it running. It still writes
  nothing to the mirror, so wacli runs it without `--read-only` (which
  refuses it) but its failures read as a read's: an outcome that is not known
  is `upstream_error`, never `uncertain`, and the service, which knows which
  of its operations write, answers a stopped or late one the same way.
- **History starts at pairing.** The mirror holds what WhatsApp gave the
  linked device: what the phone sends while pairing, which is thin and best
  effort, and every message from then on. Asking the phone for older messages
  is best effort too: the phone must be online, and nothing added does not
  prove that nothing older exists. The skills say so.
- **A chat is a JID, never a name or a number**: a person (`…@s.whatsapp.net`,
  which carries their number), a contact whose number is hidden (`…@lid`,
  which carries none), a group (`…@g.us`), a channel or a broadcast list.
  Anyone can choose any name, wacli matches recipients by name loosely, and a
  number tells nothing of the account behind it until the number check asks
  WhatsApp.
- **Rows that are not messages are dropped and counted.** wacli keeps a row
  for protocol traffic it could not read (no text, media, reaction or quote);
  a read leaves such rows out and says how many, so they never count as
  activity.
- **Other people's words are data.** Message text, names, captions and file
  names are written by other people; every read tool's description and the
  skills say so, and nothing a message says is followed as an instruction.

## Files

- **Files go in and out only through the directories a setting names**,
  judged by real path, so a link that leads elsewhere counts as elsewhere.
  The state directory and the tools' own install directory are never among
  them. Which settings, and their defaults, are settled with the tools that
  save and send files.

## Writes

- **A write's arguments are the whole change**: the chat by JID, the text as
  it should arrive (surrounding blank space trimmed), the files by path.
  Nothing is chosen at run time from the current state. The harness shows the
  arguments when it asks, so what it shows is what goes out.
- **A send's outcome is never guessed.** A result means WhatsApp accepted the
  message, not that it was delivered or read. A failure known to happen
  before anything left (the service not running, arguments wacli refuses, a
  request still queued when its time ran out, which wacli reports as not
  sent) throws its code. Every other failure (a time-out after the message
  was handed over, a lost connection, an abnormal exit, output that cannot be
  read) throws `uncertain`: the message may have gone out, the mirror may not
  show it yet, and the chat is checked before any second send. A resend that
  guessed wrong reaches the other person twice.

## Toolsets

- **One per domain**: `account`, `chats`, `contacts`, `history` (asking the
  phone for older messages), `files`, `sends`, and `actions` for what the
  user does to messages and chats beyond sending.
- **`account`, `chats`, `contacts`, `history` and `sends` are on by
  default.** They cover reading a chat and answering it; asking for older
  history writes only to the user's own mirror and sends nothing to anyone,
  and reading or counting a chat often needs it. Saving received files writes
  to disk and opens archives, and the actions change messages and chats other
  people have already seen, so each is one setting away.
