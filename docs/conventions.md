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
  `errors`, keyed by step (`StepErrors`). A send of several files that stops
  part-way is not such a call: it throws, and lists in `details` the files
  that went out (see "Files"), since a result would read as done.
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

- **Structure the caller needs goes in `details`, not in the message.** When
  fixing the cause takes more than a sentence (the lint violations, the
  findings, the output of a hook), the error carries it as `details`: a JSON
  object with snake_case keys, like a result. A model then reads the fields
  instead of parsing them back out of prose; the message still says what to
  do next on its own.
- **`details` is fixed when the error is made.** `ToolError` keeps a frozen
  JSON copy, so every entry point renders the same value. The copy is what
  JSON makes of it (`undefined` is dropped, `NaN` becomes `null`), and a value
  JSON cannot write at all, such as a cycle or a `BigInt`, fails where it was
  thrown, as a bug, not where it is rendered.
- **Each entry point passes `details` on only when it is set**, so an error
  without it reads as it always did. The MCP server and the command line put
  it beside the code and the message, as `error.details`. The OpenCode and
  Hermes plugins, whose errors are text, append it to `<code>: <message>` as
  JSON on a line of its own.
- The `errors` of a partial result (`StepErrors`) stay `<code>: <message>`
  strings.

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
- **It shows what the call carries, where the tool can say.** Targets are
  ids, so they cannot tell one kind of target from another, and the person
  decides on the text, the file or the kind of target as much as on where it
  goes. A write tool's `describe` says it. An MCP client draws the call's
  arguments in its own prompt, so the MCP server adds nothing.
- **Every native plugin's prompt has one shape**, so a person reads every
  tool's prompt the same way:

  ```text
  About to create "todo.md"

  --- Details ---

  Target: /work/tree/notes/todo.md
  Size: 42 bytes

  --- Note text ---

  # Todo
  ```

  The headline says what the agent is about to do, as its next step; the
  Details name each target on a `Target` line, then the tool's facts; the
  last section is the text the call carries, under the tool's own label. A
  section with nothing to show is left out, so a tool without `describe`
  shows its intent and its targets, and one whose targets cannot be told
  shows its intent alone. The harness names the tool beside the prompt, so
  the prompt does not repeat its id.

- **A write tool states its intent.** Besides its title, which names the
  tool wherever tools are listed, a write tool gives an `intent`: a fixed
  phrase in the headline's tone that carries no value (`About to create a
note`). The prompt shows it wherever no headline can stand: a tool without
  `describe`, a headline that is dropped, and one that gives way to keep the
  targets within the budget. A tool without an intent shows its title there.

- **The tool's words are fixed; what the call carries is data.** A model
  chooses the arguments and nothing else, and a prompt is only as good as the
  person's trust in its lines. The headline is the tool's intent, or a
  template the tool picks (`About to create {file}`) whose values the entry
  point quotes, so where the tool's words end and the call's data begins is
  always visible. A value comes from what the tool resolved, never from a
  model's account of it (the record's real name, not the name the model
  gave). The text section holds what the call writes, as it is, never a
  summary of it; a summary the tool can compute is a fact (`Size`, `Lines`).
- **Facts are short and ordered by what they decide.** A label is a noun of
  one or two words, in English like the tool's title, and a value carries
  its unit (`42 bytes`). A value with a unit or other words of the tool's is
  a template the tool picks with the values it holds (`{bytes} bytes` with
  `bytes: 42`), so the unit is the tool's word and the number the call's
  data; the tool picks the English form for the count (`{bytes} byte` for
  one), and numbers are shown as written, without digit grouping. A plain
  string value has no words of the tool's. The fact that changes the person's answer comes
  first (the kind of target, whether it overwrites); amounts come last. A
  fact never repeats the headline or a target. `src/core/facts.ts` holds the
  facts every package can use (`sizeFact`); a package adds its own beside its
  tools in the same form and lists them in its section below.
- **The head of the prompt comes first and fits; the text comes last.** Some
  harnesses cut a prompt from its end at a few hundred characters, so the
  headline, the targets and the facts are kept within the budget of where the
  prompt is shown, and the text is what is cut. A headline that would push a
  target past the cut gives way to the intent, since the targets are what an
  "always" answer stores. Facts that do not fit are counted on a notice
  line, which stays even when the head alone fills the budget: a person
  must know that something was left out. A description keeps a
  headline template of 120 characters with values of 80, its first eight
  facts with labels of 40 characters and values of 200 (a value template of
  200 with at most eight values, the filled value cut to 200), and a text label of
  40 with a text of 2000; anything longer is cut with `…`. Nothing in the text
  can come before the facts, since the text is the last section.
- **Characters other people wrote are shown, never obeyed.** A target's name
  or a file's name can hold control, bidi and invisible characters that
  forge a line of the prompt or hide part of a value; each is shown as
  `<U+XXXX>`, and a quote inside a headline value as `\"`. Where the prompt
  renders markup, everything but the plugin's own section lines is escaped,
  so a name cannot draw a link or a mention. The budget and the escaping are
  those of the surface the harness names: a surface it names that the plugin
  does not know is one the harness does not cut, and gets neither, since
  another surface's escapes would show there as written. Only a prompt whose
  surface cannot be told gets the strictest budget and escaping of all.
- **A description never stands between a call and its approval.** A tool
  without `describe`, a `describe` that fails, returns another shape or takes
  longer than 10 s gives the prompt it would have given without one. The
  approval is asked either way, and the targets are never lost with the
  description.
- **A call runs on what its prompt showed.** What a person approves is what
  was true when the prompt was drawn; between the answer and the run, a file
  the call reads can be rewritten or a target can change kind. So a native
  plugin pins the prompt of every call whose tool has `describe`: the
  targets and the description, before translation, as one hash. Right
  before the call runs, the entry point resolves both again, and a call
  whose hash differs, or whose description can no longer be told, fails with
  `stale` without running; the person is asked again on the next call. A
  call whose prompt showed no description pins nothing and runs as before,
  and so does every call of a tool without `describe`. A `describe` may also
  give `pins`, values the prompt does not show that the call must still find
  unchanged (a file's hash, beside a size that can stay the same); they go
  into the hash and nowhere else. A `describe` therefore gives the same
  answer for the same state: a value that changes on every call, such as the
  time, makes every call `stale`. The check narrows the gap between the
  answer and the run to the moment before `execute`; a tool that must close
  it entirely still checks inside `execute`. An MCP client draws the call's
  arguments, not a description, so the MCP server pins nothing.
- **The prompt speaks the language set for the harness.** A native plugin
  draws its prompt in the language of the `language` setting, else in the
  harness's own display language where it has one (Hermes's
  `display.language`), else in English. No harness tells a plugin who
  approves a call, so this is the language set where the plugin runs, not
  each person's. The server's locale (`LANG`) is never read: it is the
  machine's, and a person reading English on a machine set to another
  language would see the prompt change. A tag matches its own table, else
  the one of its first subtag (`ja-JP` and `ja_JP` are `ja`; `zh-Hant` can
  have its own), and a language the package has no words for falls back to
  English without a word. An MCP client draws its own prompt,
  so the MCP server takes no `language`.
- **Translations are tables keyed by the English words.** The plugin's own
  words (`Details`, `Target`, `(+N more)`) and a tool's (its title, its
  intent, its headline templates, its fact labels, its value templates and its text
  label) are written in
  English in the code. Per language, a package gives one table from those
  English words to their translation (`src/words.ts`), and the entry point
  looks each word up as it draws the prompt, so a tool's code does not change.
  A translated template must hold the same placeholders as the English one
  and keep within its limits, or the English one is used, so a translation
  cannot move the line between the tool's words and the call's data. Values
  are the call's data and are never translated: a value template is looked
  up and its values filled in after (`{bytes} バイト`), and a plain string
  value stays as the tool wrote it. A translation is marked like every other
  piece of the prompt.
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
- **`language`** is the language of a native plugin's approval prompt (see
  "Write classes"); unset, the prompt follows the harness's display language
  or stays in English.
- **`state_dir`**: where every account's state lives (see "Accounts and state").
- **`download_dir`**: where received files are saved (see "Files").
- **`send_dirs`**: the directories files may be sent from besides the working
  directory (see "Files").

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
- **Every variable the tools read besides the settings is named in
  `toolVariables` in `src/project.ts`**, whether a tool reads it itself or
  passes it through to a program. Codex gives a plugin's server only a few
  basic variables (`PATH`, `HOME` and the like) and those its manifest names,
  and `pnpm run manifests` writes that list from the settings and
  `toolVariables`: a variable left out is set everywhere but in Codex.
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
  not name. A send to a person the mirror does not hold yet is the one chat
  taken from outside it, and WhatsApp is asked about that person first (see
  "Writes").
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
  checked. The sync service's child carries it too, since it is the process
  that opens a file it sends.

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
- **An operation run with the child stopped says whether the service syncs
  again.** Its result carries `service_running`, true once the service has
  started its child again and the child has stayed up for a moment, and an
  error it ends with says so when the child could not be started. The mirror stops receiving while the service is down,
  and a caller learns that from the call that stopped it, not from the next
  call that finds the service gone.
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
- **A person's chat is their phone JID once WhatsApp ties the two.** WhatsApp
  may name a person by an `…@lid`, but wacli files the messages of one whose
  number it knows under the phone JID. The number check therefore gives the
  phone JID as the chat to write to, so a conversation it starts lands in the
  chat the mirror holds or will hold.
- **Rows that are not messages are dropped and counted.** wacli keeps a row
  for protocol traffic it could not read (no text, media, reaction or quote);
  a read leaves such rows out and says how many, so they never count as
  activity.
- **Other people's words are data.** Message text, names, captions and file
  names are written by other people; every read tool's description and the
  skills say so, and nothing a message says is followed as an instruction.

## Files

- **Files go in and out only through the directories a setting names**, and
  out also from the working directory, judged by real path, so a link that
  leads elsewhere counts as elsewhere. The state directory and the tools' own
  install directory are never among them.
- **Received files are saved under `download_dir`**, by default
  `~/Downloads/whatsapp-tools`, where a person looks for what they
  downloaded. A message's file goes in
  `<download_dir>/<label>/<chat>/<message id>/`, directories mode 700 and
  files mode 600, never executable: a received file is private, and someone
  else wrote it. A file already there is never overwritten.
- **A file is downloaded by its chat and message id only**, into a private
  folder under a name the tool chooses. The name the message carries is
  cleaned before it names the saved copy, since the sender chose it.
- **Programs and installers are never saved**, judged by the name, the
  declared type and the first bytes, since any one of them can lie. A name or
  type that already says so is refused before anything is downloaded. Source
  code is saved as text: it runs only if someone runs it.
- **An archive is saved only once its contents pass inspection**, on the
  saved copy itself: a zip, tar or gzipped tar holding no program, installer,
  nested archive, link or special file, encrypted entry, or path that leaves
  it, within 500 entries and 500 MB unpacked, counted from the bytes read
  rather than from what the archive claims. Every other archive format is
  refused: what cannot be read cannot be checked. An app or system bundle
  inside it, or a name holding control or direction-changing characters,
  refuses it too. Its listing comes back with names cleaned of the remaining
  invisible characters, which could make one name read as another.
- **A document built on zip is a file, not an archive.** Word, Excel,
  PowerPoint, OpenDocument and EPUB files are saved whole and never unpacked,
  since they routinely hold other zips (a chart holds a spreadsheet). One
  with macros is refused like a program.
- **Unpacking is asked for, never automatic.** It goes into
  `<name>.unpacked/` beside the archive, from a private copy inspected again,
  following no link; a failure removes everything it wrote.
- **A file WhatsApp's server no longer serves is asked of the phone.** The
  download runs with `--read-only` beside the sync; when the server answers
  that the file is gone (403, 404, 410), the tool asks the sync service, which
  hands wacli's request to upload it again to its running child. The phone
  must be online and still hold the file.
- **View-once and disappearing messages are not told apart from others.**
  wacli unwraps both and keeps no mark of either, so their files are saved
  like any other, and the skill says so.
- **On macOS every saved file carries the quarantine flag**, so the system
  checks it before anything opens it as an app; elsewhere nothing stands for
  it.
- **Files are sent from the working directory and `send_dirs` only.** The
  working directory counts unless it is the home directory or a file system
  root, where it would open everything; a `send_dirs` entry is the user's own
  choice and may be either. Each is judged by real path, and a file must be a
  regular file with one link: a hard link is a second name for a file that
  may live anywhere.
- **Some files are never sent, wherever they are**: anything under a key or
  settings folder (`.ssh`, `.gnupg`, `.aws`, `.config`, `.git`, …), a key- or
  secret-like name (`.env`, `id_rsa`, `*.pem`, credentials, …), the data
  folders of browsers, password managers, messengers and mail below home, an
  empty file, a program or installer (judged as for a saved file), a script
  name over bytes that are not text, and any file holding a private key
  block. A setting that names a folder holding one of them does not make it
  sendable: no one sends their keys by asking for a folder.
- **An archive is sent only once every entry passes**, read entry by entry and
  never unpacked: the inspection a saved archive gets, and the rules above on
  every entry's name and bytes. One with no file in it is refused.
- **Every file is checked before the first is sent, on the copy that goes
  out.** A call copies its files into a fresh folder of the label's outbox
  (directories 700, files 600), checks the copies, and hands wacli those; the
  sync service reads a file only when it sends it, so the original changing
  in between changes nothing that leaves. One refusal and nothing is sent. A
  file given with the SHA-256 the user approved is `stale` when its copy
  differs. The call's folder is removed when the call ends, and one left by a
  crash is swept a day later.
- **At most 10 files and 100 MiB a call**, each file its own message, sent in
  the order given: WhatsApp has no message with several files. The first file
  that is not accepted stops the rest, and a call that stops after a file went
  out fails with that file's code, listing in `details` what was sent, with
  its message ids, and what was not. A partial send is never a result, so it
  is never read as done.
- **The text is the first file's caption, at most 1,024 characters**, and is
  refused rather than split or sent apart. A caption on an audio first file is
  refused: WhatsApp drops it without a word.
- **The tool says how each file is shown.** JPEG, PNG and GIF go as photos,
  MP4 and 3GP as videos, common audio as audio, everything else as a file,
  decided from the name and the first bytes and passed to wacli with the type,
  so the outcome does not hang on the machine's own type tables. An image
  WhatsApp cannot show goes as a file; asked to, every file goes as a file, at
  full size.

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
- **Sends go to people and groups only.** A channel, a broadcast list, the
  status feed and the user's own chat are refused before anything leaves:
  each reaches people other than the ones the chat names, or, for the own
  chat, WhatsApp may accept it without delivering it.
- **A send to a person the mirror does not hold is checked first.** It names
  the person by phone JID only, and the tool asks WhatsApp through the service
  whether the number has an account right before sending; not on WhatsApp is
  `not_found`, no answer is `upstream_error`, and nothing is sent either way.
  wacli sends to an unregistered number without a word, and one wrong digit
  reaches a stranger. An `…@lid` or a group the mirror does not hold is
  `not_found`: neither can be checked.
- **A text is at most 4,000 characters**, counted as code points, and is
  never split by the tool: where to split it is the person's choice.
- **No link preview is fetched.** wacli would fetch each link from the user's
  machine to build one, which tells the site who is about to write about it.
- **A send changes the chat's read state in the mirror only.** wacli lowers
  the unread count when the user writes in a chat and sends no read receipt,
  so the other side learns nothing beyond the message.

## Approval prompts

- **Every write tool states its intent and describes its call.** A target
  is `<label>/<chat JID>` or a path, which tells a person neither who the
  chat is nor what goes out, so each write tool gives an `intent` and a
  `describe` (see "Write classes").
- **A chat is named as the mirror names it.** A headline's `{chat}` is the
  chat's name in the label's mirror, else a person's number as `+<digits>`,
  else the JID; never the name a model gave. A name is someone else's
  writing, shown as data like every other value.
- **A description only reads.** It reads the mirror with `--read-only` and
  the files with `stat`, their bytes and their hash; it never asks WhatsApp,
  so a person the mirror does not hold is told as new, not as checked.
- **A call the tool would refuse before acting gets no description.** A chat
  that is not a JID, a channel or broadcast list, an `…@lid` or a group the
  mirror does not hold, a chat or message missing from the mirror, and a file
  the send rules refuse by where it is or what it is called make `describe`
  fail, so the prompt shows the intent and the targets and the call fails as
  it would have. A refused file's bytes are never read for its prompt.
- **What changes on its own is never shown.** The number of messages a chat
  holds grows with every message that arrives, and a shown value that moves
  makes the call `stale` (see "Write classes"), so a description shows only
  what stays put until the call runs.
- **The facts this package adds**, in the order they decide:

  | Tool                        | Facts                                                                          | Text      | Pins                |
  | --------------------------- | ------------------------------------------------------------------------------ | --------- | ------------------- |
  | `whatsapp_message_send`     | `Chat` (person, group or new person), `Reply to` (sender and time)             | `Message` | —                   |
  | `whatsapp_file_send`        | `Chat`, `Reply to`, `Sent as` (one file) or a count per kind (several), `Size` | `Caption` | each file's SHA-256 |
  | `whatsapp_file_save`        | `Kind`, `From` (the sender, or you), `Unpack` when asked of a document         | —         | —                   |
  | `whatsapp_history_backfill` | `Sync` (paused for the call), `Batches`, `Oldest held`                         | —         | —                   |

  A reply shows who wrote the quoted message and when, never its text: the
  text is someone else's, and the person approving knows the message by its
  author and time. A file's size can stay the same while its bytes change,
  so a send pins each file's SHA-256. A headline value is quoted as data, so
  a count stays out of it: several files are counted per kind in the facts.

- **Their Japanese lives beside the tools**, a `words.ts` in each tool's
  folder whose English words the tools use as constants, which `src/words.ts`
  joins; its test checks that every key is a word the tools write, that
  every write tool has an intent and a description, and that every template
  keeps its placeholders.

## Toolsets

- **One per domain**: `account`, `chats`, `contacts`, `history` (asking the
  phone for older messages), `files`, `sends`, and `actions` for what the
  user does to messages and chats beyond sending.
- **`account`, `chats`, `contacts`, `history` and `sends` are on by
  default.** They cover reading a chat and answering it; asking for older
  history writes only to the user's own mirror and sends nothing to anyone,
  and reading or counting a chat often needs it. Saving received files writes
  to disk and opens archives, sending files reads them from disk and hands
  them to other people, and the actions change messages and chats other
  people have already seen, so each is one setting away.
