import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { fileURLToPath, pathToFileURL } from "node:url"
import { PLUGIN_NAME } from "./package-name.mjs"

const PLUGIN = fileURLToPath(new URL("../dist/opencode.js", import.meta.url))
const SERVER = fileURLToPath(new URL("../dist/mcp.js", import.meta.url))
/** Tools the default settings list: the read tools and the write tools of the default toolsets. */
const DEFAULT_TOOLS = ["whatsapp_chat_read", "whatsapp_contact_read", "whatsapp_history_backfill"]
/** Tools of the toolsets that are off by default. */
const OPT_IN_TOOLS = ["whatsapp_file_save"]

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

/** The tool names the MCP server lists with default settings; it draws on the same registry as the plugin. */
async function mcpToolNames() {
  const client = new Client({ name: "smoke", version: "0.0.0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }))
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort()
  } finally {
    await client.close()
  }
}

try {
  const { default: plugin } = await import(pathToFileURL(PLUGIN).href)
  expect(
    typeof plugin?.id === "string" && typeof plugin.setup === "function" && typeof plugin.server === "function",
    `Expected a default export with id, setup and server, got ${JSON.stringify(Object.keys(plugin ?? {}))}.`,
  )
  expect(plugin.id === PLUGIN_NAME, `Expected the plugin to be named ${PLUGIN_NAME}, got ${plugin.id}.`)
  console.log(`The OpenCode plugin ${plugin.id} exports setup and server.`)

  const expected = await mcpToolNames()

  const added = []
  const skills = []
  await plugin.setup({
    options: {},
    tool: { transform: async (callback) => callback({ add: (tool) => added.push(tool.name) }) },
    skill: { transform: async (callback) => callback({ add: (skill) => skills.push(skill.id) }) },
    session: { get: async () => ({}) },
    permission: { assert: async () => {} },
  })
  expect(
    DEFAULT_TOOLS.every((id) => expected.includes(id)),
    `Expected the MCP server to list ${DEFAULT_TOOLS.join(", ")}, got ${JSON.stringify(expected)}.`,
  )
  expect(
    JSON.stringify(added.sort()) === JSON.stringify(expected),
    `Expected setup to register ${JSON.stringify(expected)}, got ${JSON.stringify(added)}.`,
  )
  console.log(`setup registers ${added.length} tools (${added.join(", ")}) and ${skills.length} skills.`)

  const { tool } = await plugin.server({}, {})
  const served = Object.keys(tool).sort()
  expect(
    JSON.stringify(served) === JSON.stringify(expected),
    `Expected server to return ${JSON.stringify(expected)}, got ${JSON.stringify(served)}.`,
  )
  console.log(`server returns ${served.length} tools: ${served.join(", ")}.`)

  expect(
    OPT_IN_TOOLS.every((id) => !served.includes(id)),
    `Expected ${OPT_IN_TOOLS.join(", ")} to be left out by default, got ${JSON.stringify(served)}.`,
  )
  const all = Object.keys((await plugin.server({}, { toolsets: "all" })).tool)
  expect(
    OPT_IN_TOOLS.every((id) => all.includes(id)),
    `Expected toolsets "all" to give ${OPT_IN_TOOLS.join(", ")}, got ${JSON.stringify(all)}.`,
  )
  console.log(`${OPT_IN_TOOLS.join(", ")} come only with the toolsets that are off by default.`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
