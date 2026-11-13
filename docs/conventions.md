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
- **The MCP server takes the call's directory from the client.** It uses a
  directory sent with the call (Codex), else the client's first usable root,
  else the process's working directory; never inside the install directory.
  This keeps a server started in its install directory out of the working tree.

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
  must know that something was left out. The facts a description drops past
  its eighth are counted on the same line, `(+N more)` after the facts, in
  every prompt, budget or none. A description keeps a
  headline template of 120 characters with values of 80, its first eight
  facts with labels of 40 characters and values of 200 (a value template of
  200 with at most eight values, the filled value cut to 200), and a text label of
  40 with a text of 2000; anything longer is cut with `…`. Nothing in the text
  can come before the facts, since the text is the last section.
- **A cut text says how much it leaves out.** A `…` also ends many ordinary
  messages, so it alone cannot tell a person that the text goes on, or how
  far. A text cut at its 2000 characters is followed by a notice line,
  `(+N more characters)`, and a fact's value cut at its 200 by the same
  notice after it on its line, where the line still fits the budget; a value
  the budget cuts further ends in `…` alone, since what it drops is no longer
  counted in the tool's characters. N counts the code points left out of what
  the tool gave, the unit the cut counts (`(+1 more character)` for one), and
  the notice is the plugin's own words, translated like the facts' notice.
  Only the head counts towards the budget, so the text's notice is lost
  wherever the harness cuts the text, which then shows its own end mark.
- **Characters other people wrote are shown, never obeyed.** A target's name
  or a file's name can hold control, bidi and invisible characters that
  forge a line of the prompt or hide part of a value; each is shown as
  `<U+XXXX>`, and a quote inside a headline value as `\"`. Where the prompt
  renders markup, everything but the plugin's own section lines is escaped,
  so a name cannot draw a link or a mention. The budget and the escaping are
  those of the surface the harness names. A surface the harness shows as
  written, such as its own clients, gets neither. A surface it names that the
  plugin does not know is one the harness does not cut, so it gets no budget,
  but it may render markup the plugin cannot tell, so it gets the strictest
  escaping of all: an escape shown as written reads as a stray backslash,
  while a name left unescaped can draw a link or a mention. A prompt whose
  surface cannot be told gets the strictest budget and escaping of all.
- **A description never stands between a call and its approval.** A tool
  without `describe`, a `describe` that fails, returns another shape or takes
  longer than 10 s gives the prompt it would have given without one. The
  approval is asked either way, and the targets are never lost with the
  description.
- **A call no answer may let run is refused before anyone is asked.** Some
  calls are out of reach whatever the person would say, such as one naming
  an object the settings keep away from the agent; a prompt for it would
  show what it names and invite an "allow" that cannot be honored. A tool
  that can tell such a call from its arguments and settings gives a `gate`
  (see "The core contract"). Every entry point runs it before the approval
  and again before `execute`, so a refusal is the call's result, as an
  error, and no prompt is drawn: a native plugin asks nothing, and the
  Hermes plugin blocks the call. Unlike `targets` and `describe`, a gate
  fails closed: one that cannot tell fails the call with `internal_error`.
  Where the question itself cannot be resolved (the Hermes plugin's `target`
  fails or times out), the person is asked as before, and the run refuses
  the call after the answer. An MCP client draws its own prompt before the server sees the call, so
  there the refusal comes after the client's question, never after the run.
- **A call runs on what its prompt showed.** What a person approves is what
  was true when the prompt was drawn; between the answer and the run, a file
  the call reads can be rewritten or a target can change kind. So a native
  plugin pins the prompt of every call whose tool has `describe`: the
  targets and the description, before translation, as one hash. The hash
  takes the description whole, before the budgets above cut it: a text past
  its 2000 characters, a value past its cut and the facts past the eighth
  are what the call carries too, so a change there is a change of the call
  even where the prompt could not show it. Right
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
- **`emoji`** maps a toolset name to the emoji the Hermes plugin shows beside
  it, merged over the package's `TOOLSET_EMOJI`; `""` shows no emoji for that
  toolset, and no other entry point shows an emoji. A value that is not a
  mapping, an entry whose value is not a string, and a name that is no toolset
  are ignored rather than refused: the setting only changes what is shown, so a
  typo must not take every tool away.
- **`state_dir`**: this package's `path` option for where every account's state
  lives, read as Options below says (see "Accounts and state").
- **`download_dir`**: this package's `path` option for where received files are
  saved, read as Options below says (see "Files").
- **`send_dirs`**: this package's `paths` option for the directories files may
  be sent from besides the working directory, read as Options below says (see
  "Files"). Repeated directories are dropped; by default there are none.
- **`exclude_chats`**: this package's `list` option of the chat JIDs every
  tool leaves out, read as Options below says (see "Excluded chats"). The
  tools read it and the service does not, so two harnesses sharing one account
  can each set their own.
- **Options** are the package's own settings, the ones the tools themselves
  read, listed in `options` in `src/project.ts` (and `OPTIONS` in the Hermes
  plugin's `project.py`), each mapping a snake_case name to its type (`text`,
  `boolean`, `number`, `list`, `path` or `paths`) or a declaration with
  `{ type, integer, min, max }`. `integer: true` requires a whole `number`;
  `min` and `max` bound a `number` or count the items of a `list` or `paths`.
  Only `type` is required. Its flag is the name with `_` as `-` (a
  `boolean` flag takes no value), its variable is `<envPrefix>_<NAME>`
  uppercased, and its plugin option or setting is the name itself. A flag wins
  over its variable, an option over its variable, and a blank text or path or
  empty list counts as unset. A `path` is trimmed; `~` alone or followed by
  `/` (or the platform separator) stands for the home directory: `HOME` when
  it is absolute, else the account's.
  The expanded path must be absolute and reaches the tool normalized, without
  a filesystem check. A `paths` value is a list of such paths, comma-separated
  in a flag or variable and an array of strings in a plugin option; items are
  trimmed and blank items dropped, and none left counts as unset. Bounds
  check only a value that is given, after blanks are dropped; unset stays
  unset. Refused values are `invalid_argument`, naming the flag, variable or
  option and what it must be. A package should not have to check a directory
  or a limit again inside its tool. They reach a tool as `context.options`,
  keyed by name, and one that is not given is absent: a neutral default means
  unset, and the tool then does nothing extra. A tool reads an option when it
  runs, so a change applies on the next call.
- **`unattended`** says that no person can answer a question, as in a
  scheduled job, CI or a headless run; **`grants_dir`** is the `path` where
  grants and their use are kept. See "Writes no one is there to approve".

## Writes no one is there to approve

When no person can answer, a harness either refuses a write or, with its
approvals skipped, runs it with no limit at all; a host's allow rule names a
tool and at most its targets, with no expiry, no count and nothing about what
the call carries. So a person delegates, in advance, a bounded set of writes,
and every entry point checks them the same way.

- **The person decides what to delegate; the package keeps only its
  guarantees.** A person who cannot delegate a write still runs it
  unattended through the host, with no bound and no record, so a rule that
  narrows what can be delegated protects nothing and only pushes the person
  there. The package limits a grant only where the mechanism needs it: the
  expiry ceiling, that only a person's answer creates a grant, and the
  signatures, the log and the lock. Everything else (which tool, which
  targets, which bounds, how many calls) is the person's choice, shown whole
  on the consent screen.

- **A setting says that no one can be asked.** No harness tells a plugin or
  an MCP server that its questions will go unanswered, and the modes that
  skip approvals are the ones with no person in the loop, so nothing is
  inferred from them. `unattended` says it. Off, the default, nothing changes
  and grants are not read. On, a read runs as before and a write runs only
  under a live grant that covers it.
- **Every write tool can be granted; a tool may add what a grant can
  bound.** A grant over any write tool limits its targets, its rate and its
  expiry. `bounds` adds more, naming each bound with its kind: `max` (a whole
  number the call must stay at or under, such as a text's length in
  characters), `allow` (whether the call may do one thing, such as attach a
  file) or `oneOf` (the values the call may use, such as DNS record types).
  `measure(args, context)` gives the call's value for each: a number, a
  boolean, or one or more of the declared values. A tool declares at most six
  bounds and a grant's values must fit a fact (200 characters), so the consent
  screen shows every one. A bound is a fact about the call, computed the same
  way every time, never the model's account of it, and it is checked whole,
  never cut to a budget as a prompt's facts are.
- **A grant** names one tool, its targets, a value for the bounds the person
  limits, a rate in calls per hour or none, and an expiry of at most 90 days.
  Its targets are names, or `*` alone for any target, the call's included when
  it cannot be told; a pattern beside or inside a name is refused. A call is
  covered when its tool matches, every target it resolves is among the
  grant's (or the grant's is `*`), every bound the grant sets is met by the
  measured value (at or under a `max`, `false` or allowed for an `allow`,
  every value among a `oneOf`'s), the grant has not expired, and, when it sets
  a rate, fewer calls than the rate ran under it in the last 60 minutes. A
  bound the grant leaves out is no limit, and the consent screen says so; a
  measure that fails or returns another shape covers nothing under a grant
  that sets a bound. Where several grants cover a call, one that names its
  targets is used before a `*` one, then the one with the fewest targets,
  then the one that sets the most bounds, then the one that expires first.
  A call counts against its grant's rate whether it succeeds or fails, and
  every call is logged whether the grant sets a rate or not.
- **Grants restrict; the host still allows.** `invoke` checks the grant
  after the gate and before `execute`, so the MCP server and the command
  line's `run` enforce it too, and the native plugins and the Hermes
  plugin's `target` check it before they ask, refusing without a question.
  The harness's own permission still decides whether the call reaches the
  package at all (an allow rule, an allowed-tools list, an approve mode), so
  a grant means the same in every harness and never lets a call through
  that the host would stop.
- **A refusal says why.** It is `forbidden`, with `details.reason`.
  `person_only` (a tool only a person's own answer may run), `no_key` and
  `tampered` (a grant or the log fails its MAC) refuse every call. Otherwise
  each grant that names the tool is checked in order, `expired`, `target` (a
  target outside the grant, or one that cannot be told, under a grant that
  names its targets), `bound` (named in
  `details.bound`) and `rate`, and the reason is the one of the grant that
  passed the most checks; `no_grant` when none names the tool. The message
  says what a person would change: a new grant, or waiting for the rate.
- **A person delegates; the agent only asks.** `<prefix>_grant_create`
  takes the tool, the targets, the bounds, the rate, the days it lasts and a
  reason. It is administrative, and its prompt is the consent screen: the
  headline names the tool (and says it may write anywhere under `*`), the
  facts the rate (or no limit), the expiry and every bound the tool declares
  (`no limit` for one left out), named targets stand as targets (a prompt
  shows no target line for `*`, so the headline carries it) and the reason
  as text, and the pin makes the
  grant exactly what the prompt showed. Widening or extending one is a new
  grant. `<prefix>_grant_read` lists the grants and their use, and
  `<prefix>_grant_revoke` removes one. They form the `grants` toolset, off by
  default.
- **Only a person's answer creates a grant.** A grant that the agent could
  give itself would bound nothing. `grant_create` is marked person-only: it is
  refused while `unattended` is on, no grant ever covers a person-only tool
  nor can one be created for it, and every
  entry point keeps a standing answer from covering it: the OpenCode plugin
  makes its permission `ask` with nothing to save, the MCP server marks it
  `requiresUserInteraction` and asks through form elicitation where the
  client offers it, whatever `confirm` says, and the Hermes plugin gives each
  call a rule key of its own. A harness run with every approval skipped asks
  about nothing, and no package can tell; the README says so for each
  harness. Revoking only narrows, so `grant_revoke` runs while `unattended`
  is on without a grant.
- **Grants and their use are signed with a key the host supplies.** The
  variable `<envPrefix>_GRANT_KEY` (at least 32 characters; a variable only,
  never a flag or a plugin option, so it stays out of configuration files)
  keys an HMAC-SHA256 over each grant and over a chained log of every call
  made under one: the grant, the tool, the targets, the measured values, a
  digest of the arguments, when it started and how it ended. A grant or a
  log edited outside the package fails its MAC, and nothing runs under any
  grant until a person revokes the grant that fails (`grant_read` marks it)
  or, for the log, clears the directory. Without the
  key, while `unattended` is on, no write runs and no grant can be created.
  The files are written under a lock and replaced whole, since several
  processes may run calls at once. An earlier copy put back whole, MACs
  included, is not detected; the expiry bounds what it can bring back.

## Skills

- **A skill names the toolset it documents**, under `metadata` in its
  frontmatter:

  ```yaml
  metadata:
    toolset: sends
  ```

  The Agent Skills format allows no other top-level key, and its validators
  refuse one. The value is a plain or quoted one-line scalar; any other form
  reads as no link. A folder's name never links a skill, so every entry point
  reads the link the same way without knowing the package's toolsets.

- **A native plugin registers a linked skill only when its toolset is on**:
  when the settings register at least one tool of that toolset, from the same
  selection the tools come from. A skill that describes tools the model does
  not have invites calls that fail. So `read_only`, `tools` and
  `exclude_tools` count too: a toolset whose every tool is left out takes its
  skill with it. A skill with no link is always registered.
- **Plugins that install the skill folder whole cannot follow the settings**:
  Claude Code, Codex, Grok Build and Antigravity load every skill, since the
  settings reach only the MCP server.
- **Every linked skill names one of the package's toolsets**; a test checks
  it, since a misspelt link would hide the skill wherever it is filtered.
- **A skill that works across toolsets names the one it cannot work without.**
  The link holds one toolset, and a skill linked to none would be registered
  with every tool it describes turned off. Its body says which steps to skip
  when another toolset's tools are missing, and it leans only on toolsets that
  are on by default, since the plugins that install the skill folder whole
  list it whatever the settings select.

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- Any tool, read or write, may declare `gate(args, context)`, which throws a
  `ToolError` (usually `not_found`, worded as for an object that does not
  exist) for a call no approval may let run, and returns otherwise. `invoke`
  runs it after the arguments are checked and before `execute`; the entry
  points also run it before they ask (see "Write classes"). It is cheap, it
  reads only what it needs to decide, and its message says no more about
  the target than the arguments already do.
- A write tool may declare `bounds` and `measure(args, context)`, which say
  what a grant over it can limit beyond its targets, rate and expiry, and
  what this call's values are (see "Writes
  no one is there to approve"). `defineTool` refuses a `measure` without
  `bounds`, a bound of an unknown kind, a `oneOf` with no values and more than
  six bounds.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree), the values of the package's own settings as `options` (see
  "Toolsets and settings"; `gate`, `describe` and `targets` get them too) and
  an optional `confirm(request) => Promise<boolean>` hook.
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
  socket), the sync service's socket, the service record, and the short-lived
  copies of files being sent. Every call to wacli names the store with `--store`; wacli's own
  account registry (`wacli accounts`, its `config.yaml`, `~/.wacli`) is never
  used, since it lives outside the state root and any wacli command could
  change it. The state root is the `state_dir` setting, by default
  `$XDG_STATE_HOME/whatsapp-tools` when `XDG_STATE_HOME` is absolute, else
  `~/.local/state/whatsapp-tools`. One directory per label means a label is
  moved, backed up or removed as a whole, and nothing of one account sits in
  another's.
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
- **The service record names what the service starts.** Installing the
  service writes `<label>/service-program.json`, mode 600: the program and the
  script it runs, as paths, and nothing else; uninstalling deletes it. (The
  label's `service.json` is another file, the state the service last recorded
  about itself.) The account read checks that both still exist, since a
  program removed by an update stops the service only at its next start, and
  the system's own log names just the missing file. A stopped service is then
  told to be installed again, and a running one is told before it stops,
  rather than after receiving has ended.
- **Installing prefers a program at a path that outlives updates.** A
  program whose path holds its own version goes when that version is
  removed, so installing looks on the recorded `PATH` for one at a path
  without it that starts the same program, and says so when there is none.
  One under the temporary or runtime directory is passed over, since it is
  gone after a restart. The program is the same at install only: a link or
  a shim follows whatever its owner makes current later, which is the point
  of choosing it.
- **The service sends no read receipts or typing indicators of its own**, so
  the phone keeps its notifications and nobody learns that a message was read
  by a tool. A read receipt goes out only when a call asks for one (see
  "Writes").

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

## Excluded chats

A person who lets an agent use the account may want some chats kept from it:
a chat with a doctor or a lawyer, a family group. The tool lists and
`read_only` narrow what an agent can do, not where; `exclude_chats` narrows
where, per harness, so a chat open to one agent can stay closed to another
that shares the account.

- **An excluded chat is out of every tool, never out of the mirror.** The
  service keeps mirroring it as before, since the setting belongs to the
  harness that reads it and another harness may still read the chat; taking
  it off the list brings it back with its history. An entry is a chat JID as
  `list` gives it, without a device suffix: a person, an `…@lid`, a group, a
  channel, a broadcast list or `status@broadcast`, the whole status feed.
  Nothing is inherited: a community's groups are excluded one by one.
- **A person may have two JIDs, so an exclusion names both.** wacli files a
  person's messages under their `…@lid` until it learns their number, then
  under the phone JID, and a read of either JID may return the other's
  messages. The tools cannot read wacli's map between the two, so they match
  JIDs exactly: every row a read returns is checked by the chat it belongs to,
  and one of an excluded chat is dropped even when wacli returned it for
  another JID. The README tells the person to list both JIDs of someone who
  has both, and the phone JID once wacli shows the chat under it.
- **A call that names one is refused before anyone is asked.** Every tool
  whose arguments name a chat refuses an excluded one through its `gate`, as
  `not_found` in the words it gives for a chat it does not know, so the
  refusal says nothing an unknown JID would not. A send would ask WhatsApp
  about an unknown phone JID, so it refuses an excluded one with the answer it
  gives when WhatsApp says nothing of the number, without asking; a send to
  someone new needs WhatsApp to answer with the very JID named, so the gate on
  that JID covers it.
- **A read leaves it out before it counts or pages.** wacli takes no list of
  chats to leave out, so `list`, a search across chats and the contact search
  drop excluded rows from what wacli returns, before they sort, count or page,
  and before anything else is looked up for them; a page is never short of
  what it would be without them, and a cursor taken under one setting is
  refused under another. A search's excluded hits still count toward the hits
  one call asks wacli for, so a search that meets that cap says `incomplete`
  as it does today, and its position moves past them without showing them.
  The check of how many chats are pinned still counts every chat, since the
  limit of three is WhatsApp's.
- **The contacts leave the person out too.** The contact search drops an
  excluded JID, and a number check whose answer is an excluded chat reports
  the number as `unknown`, the answer it gives when WhatsApp cannot tell, so
  the check says nothing an unanswered number would not.
- **A read never looks anything up in it for another chat.** A message of an
  allowed chat keeps what it carries: the sender's JID and name, the quote and
  the ids. A person whose private chat is excluded can still write and react
  in an allowed group. wacli may fill a sender's missing name from the
  contacts as it reads; the tools take that name as the message's, since they
  cannot tell it from a stored one, and say so in the README.
- **A malformed setting stops the tools that read chats.** An entry that is
  not a chat JID fails those tools with `invalid_argument` naming the setting,
  never its value, rather than leaving a chat open by mistake.
- **The setting is per harness, so it is set where the harness reads it**:
  its plugin option or setting, not the shared environment variable, when
  only one harness should leave the chat out. An MCP client draws its own
  approval before the server sees a call, so there a call naming an excluded
  chat can still be asked about by its JID, then is refused.

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
- **An action keeps to what WhatsApp's own apps allow.** A text is edited
  only by the user who sent it and within 15 minutes, a message is deleted for
  everyone only by the user who sent it and within two days, at most three
  chats are pinned, and a chat is muted for 8 hours, a week or always. Past a
  limit the tool refuses before anything leaves: wacli checks only some of
  them, and whatsmeow lets an edit through for 20 minutes, which the phone
  may not show.
- **An action names its message by chat and id, as the mirror holds it.** The
  message must be one of that chat in the label's mirror, readable and not
  deleted; a reaction is not a message to act on. What WhatsApp needs to
  address it, such as its author, comes from the mirror, never from the
  model.
- **An action's outcome follows the send's rule.** A failure known to happen
  before anything left throws its code; every other failure is `uncertain`.
  An action on a message is checked in the chat before it is tried again; an
  action on a chat sets a state, so trying it again is safe, and its
  `uncertain` says so.
- **A read receipt goes out only when a call asks for it.** Marking a chat
  read or unread changes what the user's own devices show and tells no sender;
  a call that sets `receipts` sends read receipts for the chat's unread
  messages, and its result says how many.

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

  | Tool                        | Facts                                                                                      | Text       | Pins                |
  | --------------------------- | ------------------------------------------------------------------------------------------ | ---------- | ------------------- |
  | `whatsapp_message_send`     | `Chat` (person, group or new person), `Reply to` (sender and time)                         | `Message`  | —                   |
  | `whatsapp_file_send`        | `Chat`, `Reply to`, `Sent as` (one file) or a count per kind (several), `Size`             | `Caption`  | each file's SHA-256 |
  | `whatsapp_file_save`        | `Kind`, `From` (the sender, or you), `Unpack` when asked of a document                     | —          | —                   |
  | `whatsapp_history_backfill` | `Sync` (paused for the call), `Batches`, `Oldest held`                                     | —          | —                   |
  | `whatsapp_message_edit`     | `Chat`, `Sent` (the message's time), `Current` (its text as it stands)                     | `New text` | —                   |
  | `whatsapp_message_react`    | `Chat`, `From` (the author, or you), `Sent`                                                | —          | —                   |
  | `whatsapp_message_delete`   | `Chat`, `Sent`, `Message` (the user's own text, or its kind), `Sync` (paused for the call) | —          | —                   |
  | `whatsapp_chat_archive`     | `Chat`                                                                                     | —          | —                   |
  | `whatsapp_chat_pin`         | `Chat`                                                                                     | —          | —                   |
  | `whatsapp_chat_mute`        | `Chat`, `For` (unless unmuting)                                                            | —          | —                   |
  | `whatsapp_chat_mark`        | `Chat`, `Receipts` (when marking read)                                                     | —          | —                   |

  A reply shows who wrote the quoted message and when, never its text: the
  text is someone else's, and the person approving knows the message by its
  author and time. An edit shows the text it replaces, since that text is
  the user's own. A reaction shows who wrote the message and when, never its
  text. A deletion shows the text it removes, which is the user's own, or the
  kind of a message that has none, and says the sync pauses for the call. A
  file's size can stay the same while its bytes change, so a send pins each
  file's SHA-256. A headline value is quoted as data, so a count stays out of
  it: several files are counted per kind in the facts.

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
