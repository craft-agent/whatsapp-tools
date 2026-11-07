import type { ToolSpec } from "./core"
import { whatsappAccountRead } from "./core/account/read"
import { whatsappChatRead } from "./core/chat/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [whatsappAccountRead, whatsappChatRead]
