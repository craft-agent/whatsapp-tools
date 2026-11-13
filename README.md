# whatsapp-tools

WhatsApp tools for coding agents: chats, messages, contacts, history, received files, sends and actions on the user's own messages and chats.

| Harness        | Delivery                                       | Pinned by                      |
| -------------- | ---------------------------------------------- | ------------------------------ |
| OpenCode V2    | native plugin (npm package, with skills)       | the version in the package     |
| OpenCode V1    | native plugin (npm package, no skills)         | the version in the package     |
| Claude Code    | plugin: MCP server and skills                  | the release tag, as the ref    |
| Codex          | plugin: MCP server and skills                  | the release tag, as the ref    |
| Grok Build     | plugin: MCP server and skills                  | the release tag, as `@ref`     |
| Antigravity    | plugin: MCP server and skills                  | the release tag's tree URL     |
| Hermes Agent   | native plugin (Python, calls the command line) | the release commit, as the SHA |
| other MCP host | MCP server from npm                            | the version in the package     |

The tools need [Node.js](https://nodejs.org/) 24 or later.
[`docs/conventions.md`](docs/conventions.md) describes how the tools are named
and how they behave.

## Install

Install from a release, never from the default branch: a release is a tag whose
commit carries the built `dist/`, and the default branch does not. In the
commands below, `<version>` is a release's version (`1.2.3`) and `<sha>` is the
commit its tag names:

```sh
gh api repos/craft-agent/whatsapp-tools/commits/v<version> --jq .sha
```

### OpenCode

OpenCode V2 takes the package and its options in `opencode.json`:

```json
{
  "plugins": [{ "package": "@craftsamo/whatsapp-tools@<version>", "options": { "read_only": false } }],
  "permissions": [{ "action": "whatsapp_*", "resource": "*", "effect": "ask" }]
}
```

OpenCode V1 takes the package as a string, or as a pair with its options:

```json
{
  "plugin": [["@craftsamo/whatsapp-tools@<version>", { "read_only": false }]],
  "permission": { "whatsapp_*": "ask" }
}
```

OpenCode allows any action no rule names, so the plugin's request is granted
silently unless a rule says `ask`. Read tools never ask, so the `whatsapp_*` glob
is safe.

V1 registers no skills. Unpack the package and copy its `skills/*` folders into
`~/.config/opencode/skills/`:

```sh
npm pack @craftsamo/whatsapp-tools@<version>
tar -xzf craftsamo-whatsapp-tools-<version>.tgz
mkdir -p ~/.config/opencode/skills
cp -r package/skills/* ~/.config/opencode/skills/
rm -rf package craftsamo-whatsapp-tools-<version>.tgz
```

### Claude Code

```sh
claude plugin marketplace add craft-agent/whatsapp-tools#v<version>
claude plugin install whatsapp-tools@craft-agent
```

### Codex

```sh
codex plugin marketplace add craft-agent/whatsapp-tools --ref v<version>
codex plugin add whatsapp-tools@craft-agent
```

Codex turns `-` into `_` in server names, so it shows the tools as
`mcp__whatsapp_tools__whatsapp_*`. It starts the MCP server in the plugin's
install directory and passes no roots, so the server takes each call's directory
from what Codex sends with the call: its sandbox state, which the server asks
for, else the one workspace it names.

The plugin declares `default_tools_approval_mode = "writes"`: Codex asks before
every tool not marked read-only. A user's
`[plugins."<plugin>".mcp_servers.<server>]` setting can only tighten it. Setting
`auto` there yields `prompt` (reads asked too), since Codex treats `auto` and
`writes` as incomparable.

### Grok Build

```sh
grok plugin install craft-agent/whatsapp-tools@v<version> --trust
```

Grok starts the MCP server in the session's working directory.

### Antigravity

Install from the tree of the release tag, never from the default branch, which
has no built `dist/`; Antigravity clones the tag into
`~/.gemini/config/plugins/whatsapp-tools`.

```sh
agy plugin install https://github.com/craft-agent/whatsapp-tools/tree/v<version>
```

### Hermes Agent

The plugin needs Hermes Agent 0.22 or later. Hermes installs a commit, not a
tag, and the plugin installs disabled:

```sh
hermes plugins install craft-agent/whatsapp-tools --ref <sha>
hermes plugins enable whatsapp-tools
```

If a Hermes gateway is already running, restart it (`hermes gateway restart`) to
load the plugin. While a gateway runs, `hermes chat` runs the plugin's tools in
the gateway too, so they see the gateway's environment, not the shell's: the
`PATH` that finds `wacli` and `node`, and any `WHATSAPP_TOOLS_*` variable, are
the ones the gateway started with.

The plugin runs the Node it found when Hermes started. If a version manager
removes that version while Hermes runs, a call looks for Node again; when it
finds none, restart Hermes from a shell where `node` runs.

When the package's writes depend on another Hermes plugin, such as a guard
that blocks writes no one is there to approve, name it in `require_plugins`.
Hermes keeps loading this plugin when that one fails to import or register,
and treats a manifest's `requires_plugins` as advisory. With the setting,
while a named plugin is not loaded, every write is refused before it is
approved, even under `--yolo`, `approvals.mode: off` or a remembered answer,
naming the plugin that is missing. Reads still run.

```yaml
plugins:
  entries:
    whatsapp-tools:
      settings:
        require_plugins: [write-guard]
```

### Any other MCP host

Add the server to the host's MCP configuration. Flags go in `args`:

```json
{
  "mcpServers": {
    "whatsapp-tools": {
      "command": "npx",
      "args": ["-y", "@craftsamo/whatsapp-tools@<version>", "--read-only"]
    }
  }
}
```

## Tools and skills

Each toolset comes with a skill that tells an agent how to use its tools. A
skill names its toolset under `metadata` in its frontmatter
(`metadata: { toolset: sends }`, written as a block). OpenCode V2 and Hermes
register it only when the settings register at least one of that toolset's
tools, so a profile with the toolset off, or with all its tools removed, does
not see it; a skill without a toolset is always registered. Claude Code,
Codex, Grok Build and Antigravity install the skill folder whole and pass the
settings only to the MCP server, so they list every skill whatever the
settings select. OpenCode V1 registers no skills, and its copied skills are
all listed too.

### Account (`account`)

| Tool                    | What it does                                                                                              | Class |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ----- |
| `whatsapp_account_read` | each label: pairing, sync service state, last sync and activity, wacli support and the person's next step | read  |

It reads local state only: no network, no running service needed, and no
message content, number, JID or key in its result. The skill is
[`whatsapp-account`](skills/whatsapp-account/SKILL.md), shown as
`whatsapp-tools:whatsapp-account` in Claude Code and `whatsapp-tools:account`
in Hermes. Unlike other tools, leaving out `account` lists every label.

### Chats (`chats`)

| Tool                 | What it does                                                                                                                                       | Class |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `whatsapp_chat_read` | by `method`: `list` finds chats, `view` reads one chat's messages, `search` finds messages by words, `around` reads the messages next to a message | read  |

It reads the account's local mirror only, with no network needed, and what it
returns of other people's words is data, never instructions. The skills are
[`whatsapp-chats`](skills/whatsapp-chats/SKILL.md), shown as
`whatsapp-tools:whatsapp-chats` in Claude Code and `whatsapp-tools:chats` in
Hermes, and
[`whatsapp-count-activity`](skills/whatsapp-count-activity/SKILL.md), shown as
`whatsapp-tools:whatsapp-count-activity` and `whatsapp-tools:count-activity`,
which says how to count chats and replies over a period.

### Contacts (`contacts`)

| Tool                    | What it does                                                                                                                | Class |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----- |
| `whatsapp_contact_read` | by `method`: `search` finds contacts by name, number or JID, `check` asks WhatsApp whether up to 20 phone numbers are on it | read  |

`search` reads the account's local mirror only, with no network or running
service needed. `check` asks WhatsApp through the label's running sync service,
writes nothing and adds no contact. The skill is
[`whatsapp-contacts`](skills/whatsapp-contacts/SKILL.md), shown as
`whatsapp-tools:whatsapp-contacts` in Claude Code and `whatsapp-tools:contacts`
in Hermes.

### History (`history`)

| Tool                        | What it does                                                                       | Class |
| --------------------------- | ---------------------------------------------------------------------------------- | ----- |
| `whatsapp_history_backfill` | asks the phone for one chat's older messages, in 1 to 5 batches of 50, best effort | add   |

It writes only to the label's own mirror and sends nothing to anyone. The sync
service runs it, pausing its sync for the call, so the service must be
running; the result says how many messages arrived, the oldest one now held,
why it stopped, and whether the service is syncing again. The phone must be
online, and nothing added does not prove that nothing older exists. Its skill
is [`whatsapp-chats`](skills/whatsapp-chats/SKILL.md).

A call can take up to about five minutes. Some harnesses stop a tool call
sooner by default, and the call then fails, though what arrived stays and the
service syncs again:

- **Codex** stops a call after 60 s by default; the plugin raises the limit to
  330 s. A server added under `[mcp_servers]` instead of the plugin (see
  [Settings](#settings)) needs `tool_timeout_sec = 330`.
- **Antigravity** stops a call after 180 s. Give the server
  `"timeoutSeconds": 330` in its MCP configuration.
- **Hermes** gives the plugin's calls 150 s, and 330 s to
  `whatsapp_history_backfill`, `whatsapp_file_save` and `whatsapp_file_send`;
  nothing needs setting.

### Files (`files`)

| Tool                 | What it does                                                                                             | Class |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ----- |
| `whatsapp_file_save` | saves one message's file into `download_dir`, inspecting archives and unpacking one when asked to        | add   |
| `whatsapp_file_send` | sends 1 to 10 files, up to 100 MiB, to a person or a group, one message each, checked before any is sent | add   |

Off by default: turn it on with the `files` toolset. A message's file goes into
its own folder under `download_dir` (`~/Downloads/whatsapp-tools` by default),
private and never executable, and nothing is overwritten. Programs,
installers, disk images, macro documents and archives that cannot be read are
refused; zip, tar and gzipped tar are inspected first and unpacked only when
asked. On macOS each saved file carries the quarantine flag. A file WhatsApp's
server no longer keeps is asked of the phone through the running sync service.
The skill is
[`whatsapp-files`](skills/whatsapp-files/SKILL.md), shown as
`whatsapp-tools:whatsapp-files` in Claude Code and `whatsapp-tools:files` in
Hermes.

A call that falls back to the phone can take a few minutes; the tool time
limits given above under History apply to it too.

`whatsapp_file_send` sends only from the working directory and the
directories the `send_dirs` setting names, judged by real path; a file
anywhere else is refused, and so is the state directory. Keys and secrets
(`.ssh`, `.env`, `*.pem`, …), the data folders of browsers, password managers
and messengers, empty files, programs, installers and anything holding a
private key block are never sent, wherever they are; an archive is sent only
once every entry passes, and is never unpacked. Each file is copied into the
label's outbox and checked there, so what is checked is what leaves, and a
`sha256` the user approved makes a changed file `stale`. Each file is its own
message, in the order given, with the text as the first file's caption (at most
1,024 characters, refused on audio). Photos, videos and audio WhatsApp shows
itself go as such, decided from the name and the first bytes, and everything
else as a file; `as_document` sends all of them as files. A call that stops
after some files went out fails and lists in `details` what went out, with
the message ids, and what did not, so nothing is sent twice; a file that may
have gone out is `uncertain`. A call takes at most 280 s, and the tool time
limits given above under History apply to it too.

### Sends (`sends`)

| Tool                    | What it does                                                                                  | Class |
| ----------------------- | --------------------------------------------------------------------------------------------- | ----- |
| `whatsapp_message_send` | sends one text, up to 4,000 characters, to a person or a group, with an optional quoted reply | add   |

On by default, and it goes through the label's running sync service, so the
service must be running. It sends to people and groups only: a channel, a
broadcast list and the status feed are refused. The chat is a JID from
`whatsapp_chat_read`; for someone the mirror does not hold yet, it is the
`chat` that `whatsapp_contact_read` `check` gives, and WhatsApp is asked right
before sending whether the number has an account. The text goes out as given,
surrounding blank space trimmed, never split, and with no link preview. A
result means WhatsApp accepted the message, not that it was delivered or read.
A failure known to happen before anything left says so; every other failure
after the request was handed over is `uncertain`: the message may have gone
out, and the chat is checked and the user asked before it is sent again. Like
a message written on the phone, a send lowers the chat's unread count in the
mirror and sends no read receipt. The skill is
[`whatsapp-sends`](skills/whatsapp-sends/SKILL.md), shown as
`whatsapp-tools:whatsapp-sends` in Claude Code and `whatsapp-tools:sends` in
Hermes.

### Actions (`actions`)

| Tool                      | What it does                                                                   | Class          |
| ------------------------- | ------------------------------------------------------------------------------ | -------------- |
| `whatsapp_chat_archive`   | archives a chat, or unarchives it                                              | idempotent     |
| `whatsapp_chat_mark`      | marks a chat read or unread, optionally sending read receipts                  | idempotent     |
| `whatsapp_chat_mute`      | mutes a chat for 8 hours, a week or always, or unmutes it                      | idempotent     |
| `whatsapp_chat_pin`       | pins a chat, or unpins it, up to the three WhatsApp allows                     | idempotent     |
| `whatsapp_message_delete` | deletes a message the user sent for everyone, at most two days after it        | administrative |
| `whatsapp_message_edit`   | replaces the text of a text message the user sent, at most 15 minutes after it | overwrite      |
| `whatsapp_message_react`  | reacts to a message with one emoji, or removes the user's reaction             | overwrite      |

Off by default: turn it on with the `actions` toolset. Each action goes
through the label's running sync service and acts only on a chat and a message
the mirror holds, named by JID and id from `whatsapp_chat_read`. Deleting for
everyone pauses the sync service for the call, a few seconds, and the result
says whether it syncs again. It keeps to the limits WhatsApp's own apps hold,
and refuses past them before anything leaves. A result means WhatsApp
accepted the action; a failure known to happen before anything left says so,
and every other failure is `uncertain`: the chat is checked and the user asked
before the action is tried again. A chat's archive, pin, mute and read state
are states only the user's own devices show, and setting one again is safe,
so their `uncertain` says so. Marking a chat read tells no one by default;
only when the user asks for it does `receipts: true` send read receipts for up
to 100 unread messages instead, which tells their senders and clears only the
mirror's unread count, not necessarily the phone's mark. The skill is
[`whatsapp-actions`](skills/whatsapp-actions/SKILL.md), shown as
`whatsapp-tools:whatsapp-actions` in Claude Code and `whatsapp-tools:actions`
in Hermes.

### Grants (`grants`)

Off by default. Delegates bounded writes for jobs where no person can answer.

| Tool                    | What it does                                             | Class          |
| ----------------------- | -------------------------------------------------------- | -------------- |
| `whatsapp_grant_create` | ask a person to delegate one tool's writes within limits | administrative |
| `whatsapp_grant_read`   | list grants and their use, or read the usage log         | read           |
| `whatsapp_grant_revoke` | remove a grant so no more calls run under it             | overwrite      |

Every write tool can be granted for its targets, calls per hour and expiry.
A tool adds what a grant can also limit by declaring `bounds` and giving
`measure(args, context)` in its spec; see the
[conventions](docs/conventions.md#writes-no-one-is-there-to-approve).
No tool of this package declares `bounds` yet.

## Adding a tool

1. Write the spec in `src/core/<domain>/<verb>.ts` with `defineTool`: an ID
   `<prefix>_<domain>_<verb>`, a title and description, the Zod argument and
   output schemas, its toolset and write class, and `execute(args, context)`.
   A write tool also gives `targets(args, context)`: what the call writes to,
   as a permission rule should name it. A tool whose settings can put some
   calls out of reach whatever the person answers gives
   `gate(args, context)`, which throws for such a call; it is refused before
   anyone is asked, and before `execute`.
2. Test it beside the spec (`<verb>.test.ts`), calling it through `invoke` as
   the entry points do. A tool that runs a program is tested against a fake of
   that program on `PATH`; no test reaches a real service.
3. List it in `src/tools.ts`. A new toolset goes into `toolsets` in
   `src/project.ts` (and `defaultToolsets` when it is on by default), a
   setting of the package's own into `options` (and `OPTIONS` in `project.py`
   with `config_schema` in `plugin.yaml`), and a variable the tool reads
   besides the settings into `toolVariables`.
4. Add or update the toolset's skill, `skills/<prefix>-<toolset>/SKILL.md`,
   whose frontmatter names the toolset under `metadata`.
5. Run `pnpm run build && pnpm run manifests` to list the tool in
   `plugin.yaml` and its variables in Codex's manifest, then describe it under
   "Tools and skills".

[`docs/conventions.md`](docs/conventions.md) has the rules each step follows.

A package declares each option as `text`, `boolean`, `number`, `list`, `path`
or `paths`, or as an object with `type` and optional bounds. For example, in
`src/project.ts`:

```ts
options: {
  notes_dir: "path",
  note_limit: { type: "number", integer: true, min: 1, max: 50 },
}
```

`integer: true` requires a whole number; `min` and `max` bound a number or
count a `list` or `paths` value's items. An object with only `type` means the
same as the type alone. Hermes's `OPTIONS` mirrors the declarations on one
line, with double quotes and Python's `True` for `integer`:

```python
OPTIONS: dict[str, str | dict[str, object]] = {"notes_dir": "path", "note_limit": {"type": "number", "integer": True, "min": 1, "max": 50}}
```

## Reads and writes

Every read tool is named `<prefix>_<domain>_read`. Reads can run unasked;
writes are confirmed by the harness.

| Harness     | Reads without asking                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| OpenCode    | always; the plugin asks only before a write                                                                      |
| Claude Code | the rule `mcp__plugin_whatsapp-tools_whatsapp-tools__*_read` in `permissions.allow` of `~/.claude/settings.json` |
| Codex       | always; Codex runs tools that declare `readOnlyHint` unasked, as the read tools do                               |
| Grok Build  | `grok --allow 'MCPTool(whatsapp-tools__*_read)' --allow 'MCPTool(whatsapp_*_read)'` (both rules; see below)      |
| Antigravity | the rule `mcp(whatsapp-tools_whatsapp-tools/<tool id>)` in `permissions.allow`, one for each read tool           |
| Hermes      | always; the plugin asks only before a write                                                                      |

Where a write is asked about, and where it is not:

- **OpenCode** grants any action no rule names, so a write runs unasked unless
  a rule asks for it: add the `whatsapp_*` rule shown under [OpenCode](#opencode).
- **Codex** asks before every write because of the plugin's approval mode.
  Under `codex exec` it refuses with "MCP tool call requires approval, but
  approval policy is never". For bounded jobs, see
  [Writes no one is there to approve](#writes-no-one-is-there-to-approve).
- **Grok Build** under `grok -p` refuses a write it cannot ask about, unless it
  is allowed beforehand.
- **Grok Build** calls the plugin's tools through its `use_tool` tool, and the
  agent often names a tool without its server first. Grok checks the rules
  against the name as given, so the server-qualified rule alone does not match
  that first call. The second rule matches the short name; a write still
  matches neither.
- **Antigravity** asks before any MCP tool no rule allows, reads included, and
  names the plugin's server `whatsapp-tools_whatsapp-tools` (plugin,
  then server). `agy -p` refuses a tool it cannot ask about.
- **Hermes** `hermes chat -q` refuses a write it cannot ask about; `hermes -z`
  and `--yolo` skip approval, so writes then run unasked. For bounded jobs, see
  [Writes no one is there to approve](#writes-no-one-is-there-to-approve).

A call a tool's `gate` refuses never runs, whatever the answer. OpenCode and
Hermes refuse it before they ask, so no prompt shows it; Hermes blocks it with
the tool's error. Claude Code, Codex, Grok Build and Antigravity draw their
own prompt before the MCP server sees the call, so they may still ask about
it; the server then refuses it.

## Writes no one is there to approve

A grant limits a job's writes to one tool, for at most 90 days. The person
decides the rest: the targets (named ones, or `*` for any), the bounds the
tool declares (one left out is no limit) and the calls per hour (left out,
any number). Every call made under a grant is logged. A grant never
overrides the host's permissions. The
[conventions](docs/conventions.md#writes-no-one-is-there-to-approve) give the
contract.

1. In a session where a person answers, supply the key described under
   [Settings](#settings), turn on the `grants` toolset alongside the job's
   toolset, and ask the agent to delegate. It calls `whatsapp_grant_create`;
   the prompt shows the tool, targets, rate, days, every bound the tool
   declares (`no limit` for one left out) and the reason.
   Approve once.
2. Set the same key and `unattended` for the job only, for example
   `WHATSAPP_TOOLS_UNATTENDED=true`. Otherwise grants are not checked.
3. Let the host allow the write tool in that run, as below. The grant still
   bounds each call.
4. Revoke with `whatsapp_grant_revoke`, or list grants and their use with
   `whatsapp_grant_read`.

What lets a write reach the package when no one can answer, for example
`whatsapp_message_send`:

- **OpenCode** `opencode run` rejects every question unless an allow rule
  names the tool (`"permission": { "whatsapp_message_send": "allow" }`) or the
  run starts with `--auto`.
- **Claude Code** `claude -p` needs the tool in `--allowedTools`, as
  `mcp__plugin_whatsapp-tools_whatsapp-tools__whatsapp_message_send`.
- **Codex** `codex exec` needs `approval_mode = "approve"` for that tool under
  the plugin's MCP server in `config.toml`
  (`[mcp_servers.<server>.tools.<tool>]`), since the plugin's default asks
  before every write.
- **Grok Build** `grok -p` needs both allow rules:
  `--allow 'MCPTool(whatsapp-tools__whatsapp_message_send)'` and
  `--allow 'MCPTool(whatsapp_message_send)'`, for the qualified and short names
  described under [Reads and writes](#reads-and-writes).
- **Antigravity** `agy -p` needs
  `mcp(whatsapp-tools_whatsapp-tools/whatsapp_message_send)` in
  `permissions.allow`.
- **Hermes** `hermes chat -q` denies by `approvals.single_query_mode` unless
  allowed. `-z` and `--yolo` skip approvals and run the write; the grant is
  then the only bound.

### Limits

- A run with every approval skipped (Hermes `-z` or `--yolo`, an
  always-approve mode, an explicit `allow` for `whatsapp_grant_create`, or a
  global OpenCode V1 `allow`) shows no prompt. A grant created there is not a
  person's answer, and it can be as wide as any target, no bound and no rate
  for 90 days: create grants only where the harness asks.
- An earlier copy of the grants directory put back whole is not detected.
  Expiry, at most 90 days, bounds what it can restore.
- Anyone who can read the key can sign grants. Keep it where the agent's
  tools cannot read it.
- The OpenCode V2 plugin forces a question for `whatsapp_grant_create`
  through a hook; only hosts that offer that hook run it.

The OpenCode V2 service and Hermes gateway keep the environment they started
with; see [Settings](#settings) before changing the job's variables.

## Settings

Every entry point takes the same settings. A flag wins over its environment
variable, and an option or setting wins over the variable too, except in
Hermes, noted below.

| Setting           | Flag              | Variable                       | Meaning                                                                                                                           |
| ----------------- | ----------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `toolsets`        | `--toolsets`      | `WHATSAPP_TOOLS_TOOLSETS`      | the toolsets that are on, or `all`; default those `src/project.ts` names                                                          |
| `read_only`       | `--read-only`     | `WHATSAPP_TOOLS_READ_ONLY`     | registers no tool that writes; wins over every other setting                                                                      |
| `unattended`      | `--unattended`    | `WHATSAPP_TOOLS_UNATTENDED`    | no person can answer: a write runs only under a grant that covers it; off by default                                              |
| `grants_dir`      | `--grants-dir`    | `WHATSAPP_TOOLS_GRANTS_DIR`    | where grants and their use are kept; default `$XDG_STATE_HOME/whatsapp-tools/grants`, else `~/.local/state/whatsapp-tools/grants` |
| `tools`           | `--tools`         | `WHATSAPP_TOOLS_TOOLS`         | single tools to add by ID, whatever their toolset                                                                                 |
| `exclude_tools`   | `--exclude-tools` | `WHATSAPP_TOOLS_EXCLUDE_TOOLS` | single tools to remove by ID; wins over `tools` and `toolsets`                                                                    |
| `confirm`         | `--confirm`       | `WHATSAPP_TOOLS_CONFIRM`       | MCP server only: `harness` (default) or `elicitation`, as the conventions say                                                     |
| `language`        | `--language`      | `WHATSAPP_TOOLS_LANGUAGE`      | native plugins only: the approval prompt's language, such as `ja`                                                                 |
| `emoji`           | —                 | —                              | Hermes only: the emoji shown beside each toolset, by toolset name (`""` for none)                                                 |
| `require_plugins` | —                 | —                              | Hermes only: the plugins that must be loaded; while one is not, every write is refused before it is approved                      |
| `state_dir`       | `--state-dir`     | `WHATSAPP_TOOLS_STATE_DIR`     | `path`: where every label's state lives; default `$XDG_STATE_HOME/whatsapp-tools`                                                 |
| `download_dir`    | `--download-dir`  | `WHATSAPP_TOOLS_DOWNLOAD_DIR`  | `path`: where received files are saved; default `~/Downloads/whatsapp-tools`                                                      |
| `send_dirs`       | `--send-dirs`     | `WHATSAPP_TOOLS_SEND_DIRS`     | `paths`: the directories files may be sent from, besides the working directory                                                    |
| `exclude_chats`   | `--exclude-chats` | `WHATSAPP_TOOLS_EXCLUDE_CHATS` | `list`: chat JIDs every tool leaves out, as `whatsapp_chat_read` returns them                                                     |

`WHATSAPP_TOOLS_GRANT_KEY` is a variable only, never a flag or a plugin
option. Use at least 32 characters, for example from `openssl rand -hex 32`,
stored where the host keeps secrets. Without it no write runs while
unattended and no grant can be created. Codex forwards it alongside the
settings' variables, as described below.

Lists are comma-separated in a flag or a variable. `state_dir`, `download_dir`,
`send_dirs` and `exclude_chats` are this package's own settings, listed in
`options` in `src/project.ts` and read the same way. A `path` is trimmed; `~`
and `~/…` (also with the platform separator) stand for the home directory
(`HOME` when it is absolute, else the account's). It must then be absolute and
reaches the tool normalized, without a filesystem check. A blank path counts
as unset, so the default applies. `paths` is a list of such paths,
comma-separated in a flag or variable and an array of strings in a plugin
option. Blank items are dropped, and a list with none left counts as unset.
Repeated send directories are dropped. Bounds check only a given value, not an
unset option. Refused values are `invalid_argument`, naming the flag, variable
or option and what it must be.
Hermes passes paths and lists to the command line, which checks the paths and
bounds. Where each harness reads them:

- **OpenCode** takes the plugin `options` shown above, with lists as arrays,
  `read_only` as a boolean, `state_dir` and `download_dir` as paths and
  `send_dirs` as an array of paths, and falls back to the variables. V2 runs plugins in
  its background service, which keeps the environment it started with: a
  variable set where `opencode run` starts has no effect until the service is
  restarted in that environment (`opencode service restart`). V1 runs plugins
  in its own process.
- **Hermes** takes `plugins.entries.whatsapp-tools.settings` in
  `config.yaml`:

  ```yaml
  plugins:
    entries:
      whatsapp-tools:
        settings:
          read_only: false
          exclude_tools: []
  ```

  Without a `language` setting, the approval card follows Hermes's own
  `display.language` (or `HERMES_LANGUAGE`), the language of its approval
  buttons, and else stays in English. The plugin passes its own environment
  to the command line it runs, so the variables work too. A setting that is
  off or empty (`read_only: false`, `tools: []`, `exclude_tools: []`,
  `send_dirs: []`) passes nothing, so a variable set in that environment
  still applies: `WHATSAPP_TOOLS_READ_ONLY=true` keeps the plugin read-only
  whatever the setting says. A running gateway keeps the environment it
  started with, and `hermes chat` runs the tools there while it runs; restart
  it (`hermes gateway restart`) after changing one.

- **Claude Code, Grok Build and Antigravity** start the plugin's server without
  flags and pass it the client's environment, so set the variables in the
  environment the harness runs in.
- **Codex** passes a plugin's MCP server only a few basic variables (such as
  `PATH` and `HOME`) and those the plugin's manifest names, which are the
  variables above: set them in the environment Codex runs in. A variable the
  tools read besides the settings belongs in `toolVariables` in
  `src/project.ts`; `pnpm run manifests` adds it to the manifest after the
  settings' variables. To pass flags, or to give the server a variable the
  package does not name, add the server under `[mcp_servers]` in Codex's
  `config.toml` instead of using the plugin: flags go in `args`, `env_vars`
  names the variables to forward from Codex's environment, and `env` sets
  fixed values.

  ```toml
  [mcp_servers.whatsapp-tools]
  command = "npx"
  args = ["-y", "@craftsamo/whatsapp-tools@<version>", "--read-only"]
  env_vars = ["WHATSAPP_TOOLS_TOOLSETS"]
  tool_timeout_sec = 330
  ```

`exclude_chats` keeps the named chats out of every tool, by JID exactly as
`list` returns it (no device suffix). Lists, searches and the contact search
leave them out, and `status@broadcast` is the whole status feed. A number
check whose answer is an excluded chat reports `unknown`: that means
unavailable through the tools, not that the number is off WhatsApp. A call
naming an excluded chat is refused in the same words as an unknown chat, and a
send to an excluded phone JID gets the "WhatsApp gave no answer" refusal, as an
unchecked number would. Every row a read returns is checked by the chat it
belongs to. A community's groups are excluded one by one, and the pin limit of
three still counts excluded pinned chats. A malformed entry fails the tools
with `invalid_argument`.

A person may have a phone JID and an `…@lid`, and the tools match JIDs exactly,
so list both for someone who has both, and the phone JID once wacli shows the
chat under it. Messages of an allowed chat keep the sender's JID and name,
quotes and ids; wacli may fill a missing sender name from the contacts as it
reads. The sync service keeps mirroring the excluded chats.

Set it per harness, in that harness's plugin option or setting, not the shared
`WHATSAPP_TOOLS_EXCLUDE_CHATS` variable when only one harness should leave a
chat out. For OpenCode V2, in `opencode.json`:

```json
{
  "plugins": [
    {
      "package": "@craftsamo/whatsapp-tools@<version>",
      "options": { "exclude_chats": ["<jid>@g.us"] }
    }
  ]
}
```

For Hermes, in `config.yaml` (quote each JID):

```yaml
plugins:
  entries:
    whatsapp-tools:
      settings:
        exclude_chats:
          - "<jid>@g.us"
```

OpenCode and Hermes refuse a call naming an excluded chat before asking, and
the MCP clients may still ask first, as [Reads and writes](#reads-and-writes)
says.

### Accounts and the sync service

The tools use a WhatsApp account as a linked device of the user's phone, the
way WhatsApp Web does, through [wacli](https://github.com/openclaw/wacli),
which you install yourself (`brew install openclaw/tap/wacli`, or a release
binary). They never drive WhatsApp Web or read another client's data.

- **wacli 0.26 or later.** WhatsApp stops serving old clients until wacli
  catches up with its protocol, so keep it updated; after an update, restart
  the sync service so it runs the new release.
- **Each linked device has a label**, 1 to 24 lowercase letters, digits and
  `_` (`default` when pairing names none); `grants` is reserved for the grants
  directory. A tool's `account` argument picks the label; leave it out when
  only one device is paired. The account tool instead lists every label when
  `account` is absent.
- **Each label keeps its state in one directory**, `<state_dir>/<label>/`
  (mode 700): wacli's store (the session keys, its mirror of your messages,
  downloaded media), the sync service's socket, and the copies of files being
  sent. `state_dir` defaults to `$XDG_STATE_HOME/whatsapp-tools`, or
  `~/.local/state/whatsapp-tools`. wacli's own accounts in `~/.wacli` are not
  used. Keep the directory out of backups you share: the keys read and send as
  you.
- **A sync service runs for each label**: it keeps the mirror current, and
  every send and every other write goes through it, so the tools that write
  need it running. Reads work with or without it. History starts when the
  device is paired, with what the phone sends then; older messages can be
  asked of the phone, best effort.
- **WhatsApp unlinks a device unused for 30 days**, and every linked device
  when the phone has been unused for 14; a phone takes four linked devices at
  most. A running service keeps the device in use. An unlinked label is paired
  again from the phone.
- **wacli is not an official client.** WhatsApp has no API for personal
  accounts, and it may limit or ban an account it finds using an unofficial
  one.

### Pairing a device and running the sync service

Install [wacli 0.26 or later](https://github.com/openclaw/wacli) first: on
macOS, `brew install openclaw/tap/wacli`; elsewhere, a release binary. macOS
and Linux are supported; Windows is
[#11](https://github.com/craft-agent/whatsapp-tools/issues/11).

The commands come with the npm package, apart from any harness plugin: a
plugin gives the tools, not a command on your `PATH`. Install the package
globally, at the version of the plugin you use, so that the service it
installs keeps a stable path:

```sh
npm install -g @craftsamo/whatsapp-tools@<version>
```

```sh
# On the phone, WhatsApp > Linked devices > Link a device, then scan the QR.
whatsapp-tools-cli pair --account work

# Start syncing at logon, and restart after a failure.
whatsapp-tools-cli service install --account work
whatsapp-tools-cli service status
```

`--account` may be left out when only one label exists (`pair` names a new
one `default`), except by `remove`, which always needs it; every command takes
`--state-dir` like the tools. With
several labels, add `--account work` to `service status` too.

Every command below follows `whatsapp-tools-cli`:

| Command                                                                             | What it does                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pair [--account <label>] [--phone <number>] [--full-history [--history-days <n>]]` | pairs this machine from a QR code, or with `--phone` prints a code to enter on the phone, then waits for the first sync |
| `sync [--account <label>]`                                                          | runs the sync service in the foreground, logging to standard error, until stopped                                       |
| `service install \| uninstall \| status [--account <label>]`                        | registers/starts the service as a launchd agent (macOS) or systemd user unit (Linux), removes it, or reports its state  |
| `remove --account <label> [--yes]`                                                  | uninstalls the service, logs the device out when possible and deletes the label's keys and history after confirmation   |

- **The service records this package's paths and Node's**, so run
  `service install` again after updating either. Where Node's path holds its
  version, as under a version manager, `service install` records a `node` on
  `PATH` at a path without it that starts the same Node, and warns when there
  is none. That `node` then runs whichever Node the manager makes current.
  `service status` and `whatsapp_account_read` say when the recorded program
  is gone, once the service has been installed with this version. On macOS its
  log is
  `~/Library/Logs/io.github.craft-agent.whatsapp-tools/<label>.log`; on Linux,
  `journalctl --user -u <unit>` as `service status` shows, and
  `loginctl enable-linger` keeps it running while you are logged out.
- **On macOS, Login Items lists the service as `whatsapp-tools-sync-<label>`**:
  the agent starts through that launcher script, which `service install`
  writes to
  `~/Library/Application Support/io.github.craft-agent.whatsapp-tools/` and
  `service uninstall` deletes. Switching the item off there stops syncing.
- **A phone takes at most four linked devices**, and each label is one of
  them. WhatsApp unlinks a device unused for 30 days, and every linked device
  when the phone has been unused for 14 days; a running service keeps the
  linked device in use, not the phone.
- **`--full-history` asks the phone for its full history** while pairing,
  instead of its recent months; `--history-days` limits how far back. It
  takes effect only while pairing, and the phone keeps sending for a while
  after `pair` ends, which reaches the mirror once the service runs. A
  device already paired gets older messages with `whatsapp_history_backfill`,
  one chat at a time, or by being removed and paired again.
- **To pair a revoked label again**, run `pair` again: the dead session is
  deleted and the mirror is kept. Use a new label for a different account.
- **Removing a label logs the device out when possible.** If it cannot,
  remove the linked device on the phone under WhatsApp > Linked devices too.
- `whatsapp_account_read` tells an agent which step a label needs.

## Layout

- `src/project.ts` — the package's name, tool ID prefix, setting prefix,
  toolsets, tool options and the other variables its tools read.
- `src/core/` — the tool contract and the tools, free of any harness and of
  the project's names.
- `src/tools.ts` — the list of every tool, which each entry point registers.
- `src/words.ts` — the translations of the tools' words, per language, which
  the native plugins use in their approval prompts.
- `src/mcp/` — the MCP server, built to `dist/mcp.js` and run by
  `whatsapp-tools`.
- `src/opencode/` — the OpenCode plugin, built to `dist/opencode.js`.
- `src/cli/` — the command line the Hermes plugin calls, built to `dist/cli.js`
  and run by `whatsapp-tools-cli`.
- `src/hermes/`, `plugin.yaml` and `__init__.py` — the Hermes plugin.
- `skills/` — one skill per toolset, `skills/<name>/SKILL.md`, which every
  harness that takes skills loads from the package or plugin root; the native
  plugins load only those of the toolsets that are on.
- `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `.mcp.json`,
  `.antigravity-plugin/` and `mcp_config.json` — the plugin manifests of the
  other harnesses. Codex reads `.codex-plugin/plugin.json`; a root
  `plugin.json` would make it load the plugin as an Agent Plugin, whose tool
  budget hides tools past a fixed size. The root `.mcp.json` is the
  configuration Grok Build reads (with `${CLAUDE_PLUGIN_ROOT}`, the variable
  both Grok Build and Claude Code expand); when working on this repository in
  Claude Code, decline the project MCP server it offers from that file.

How a release is made is in [`RELEASING.md`](RELEASING.md).

## License

[AGPL-3.0 with Commons Clause](LICENSE)
