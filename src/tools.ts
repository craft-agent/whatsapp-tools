import type { ToolSpec } from "./core"
import { whatsappAccountRead } from "./core/account/read"
import { whatsappChatRead } from "./core/chat/read"
import { whatsappChatArchive } from "./core/chat/state/archive"
import { whatsappChatMark } from "./core/chat/state/mark"
import { whatsappChatMute } from "./core/chat/state/mute"
import { whatsappChatPin } from "./core/chat/state/pin"
import { whatsappContactRead } from "./core/contact/read"
import { whatsappFileSave } from "./core/file/save"
import { whatsappFileSend } from "./core/file/send/tool"
import { whatsappHistoryBackfill } from "./core/history/backfill"
import { whatsappMessageDelete } from "./core/message/delete/tool"
import { whatsappMessageEdit } from "./core/message/edit/tool"
import { whatsappMessageReact } from "./core/message/react/tool"
import { whatsappMessageSend } from "./core/message/send"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  whatsappAccountRead,
  whatsappChatArchive,
  whatsappChatMark,
  whatsappChatMute,
  whatsappChatPin,
  whatsappChatRead,
  whatsappContactRead,
  whatsappFileSave,
  whatsappFileSend,
  whatsappHistoryBackfill,
  whatsappMessageDelete,
  whatsappMessageEdit,
  whatsappMessageReact,
  whatsappMessageSend,
]
