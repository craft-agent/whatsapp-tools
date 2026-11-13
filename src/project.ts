import type { OptionSpec } from "./core"

/** What makes this package itself; a project made from the starter sets these once (the setup script does). */
export const PROJECT = {
  /** The plugin, MCP server and program name. */
  name: "whatsapp-tools",
  /** The command line the Hermes plugin calls. */
  cli: "whatsapp-tools-cli",
  /** Every tool ID starts with `<toolPrefix>_`. */
  toolPrefix: "whatsapp",
  /** Every setting's environment variable is `<envPrefix>_<SETTING>`. */
  envPrefix: "WHATSAPP_TOOLS",
  /** The toolsets, in the order `all` lists them. */
  toolsets: ["account", "chats", "contacts", "history", "files", "sends", "actions"] as readonly string[],
  /** The toolsets on when a setting names none. */
  defaultToolsets: ["account", "chats", "contacts", "history", "sends"] as readonly string[],
  /** The package's own settings, which the tools themselves read: each snake_case name and its type, with bounds when it needs them. */
  options: {
    state_dir: "path",
    download_dir: "path",
    send_dirs: "paths",
    /** The chats every tool leaves out: their JIDs, as `list` returns them; the sync service still mirrors them. */
    exclude_chats: "list",
  } as Readonly<Record<string, OptionSpec>>,
  /** The environment variables the tools read besides the settings, which Codex forwards to the server after them. */
  toolVariables: [] as readonly string[],
} as const
