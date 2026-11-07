import type { ToolSpec } from "./core"
import { whatsappAccountRead } from "./core/account/read"
import { whatsappChatRead } from "./core/chat/read"
import { whatsappContactRead } from "./core/contact/read"
import { whatsappHistoryBackfill } from "./core/history/backfill"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  whatsappAccountRead,
  whatsappChatRead,
  whatsappContactRead,
  whatsappHistoryBackfill,
]
