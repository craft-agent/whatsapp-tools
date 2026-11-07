# AGENTS

whatsapp-tools is a set of tools for coding agents, implemented once and
delivered to several harnesses (OpenCode, Claude Code, Codex, Grok Build,
Antigravity, Hermes Agent) from this repository. Releases are GitHub Releases
tagged `v<version>`; consumers pin a tag or the same npm version.

## Layout

- `src/project.ts` — the package's identity: name, tool ID prefix, setting
  prefix and toolsets. The Hermes plugin's counterpart is `project.py` in its
  package.
- `src/core/` — the tool contract and the tools. Each tool is a spec with a
  Zod v4 argument schema, an output schema, a toolset and a write class;
  `execute` gets a `ToolContext`.
- `src/<entry>/` — one thin entry point per delivery, which turns the specs
  into that harness's tools: `src/opencode/` (native plugin), `src/mcp/` (the
  stdio MCP server the other plugins bundle), and `src/cli/`, the command line
  the Hermes plugin (Python, in `src/hermes/`) calls.
- `docs/conventions.md` — the rules every tool follows.
- Tests sit beside the code they test (`*.test.ts`, `bun test`).

## Rules

- **Every tool follows [`docs/conventions.md`](docs/conventions.md).** A
  change to a convention changes that file first, with its reason.
- **`src/core/` knows no harness, no caller and no project.** No harness,
  product or machine names, paths or session conventions in code,
  descriptions or messages; the project's names reach it only through the
  entry points. It uses `node:*` modules only, never a runtime's own globals,
  so it runs on Node and Bun.

- **Tool IDs are a public interface.** Permission rules and skills key on them
  (`<prefix>_<domain>_<verb>`); renaming one is a breaking change.
- **A tool's write class is its contract with the harness.** The class sets
  the annotations every entry point publishes, so it must be the strictest
  class the tool's arguments can reach. `read_only` registers no write tool;
  annotations are hints, never the boundary.
- **Every program a tool runs goes through one runner**, which fixes a
  non-interactive environment and maps failures to error codes.
- **Every call to wacli goes through the one wacli runner**, with the label's
  own `--store`; a tool never opens the store's files, whose layout is
  wacli's own.
- **Only the sync service holds a store, and every write goes through it.** A
  second wacli process that writes meets the store's lock or connects to
  WhatsApp on its own; what the service runs with its child stopped, it
  follows by starting the child again, whatever the outcome.
- **Reads run wacli with `--read-only`.** No read writes the store; the number
  check asks WhatsApp through the service and writes nothing.
- **The keys never leave the state directory.** Nothing of the session keys
  reaches a result, an error or a log; tests use made-up accounts and numbers
  only.
- **A chat is a JID, never a name or a number**, and is looked up only in its
  label's mirror.
- **A send that may have gone out throws `uncertain`**, never success or a
  plain failure: a wrong guess sends the message twice.
- **Every commit stays small.** The pre-commit hook rejects a commit over 500
  reviewable changed lines; split the change instead of raising the limit.

## Commands

- `pnpm test`, `pnpm run typecheck`, `pnpm run format`, `pnpm run format:check`
- Single file: `bun test <path>`
- `pnpm run build && pnpm run smoke`, `pnpm run manifests:check`
- Hermes plugin (Python): `python -m unittest discover -s src/hermes/tests`
