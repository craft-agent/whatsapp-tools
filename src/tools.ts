import type { ToolSpec } from "./core"
import { whatsappAccountRead } from "./core/account/read"
import { whatsappChatRead } from "./core/chat/read"
import { whatsappContactRead } from "./core/contact/read"
import { whatsappFileSave } from "./core/file/save"
import { whatsappFileSend } from "./core/file/send/tool"
import { whatsappHistoryBackfill } from "./core/history/backfill"
import { whatsappMessageEdit } from "./core/message/edit/tool"
import { whatsappMessageSend } from "./core/message/send"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  whatsappAccountRead,
  whatsappChatRead,
  whatsappContactRead,
  whatsappFileSave,
  whatsappFileSend,
  whatsappHistoryBackfill,
  whatsappMessageEdit,
  whatsappMessageSend,
]
