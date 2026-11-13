import { ALL_TOOLS } from "../tools"

export const PERSON = "14155550123@s.whatsapp.net"
export const HIDDEN = "98765432101234@lid"
export const GROUP = "120363012345678901@g.us"
export const MESSAGE_ID = "3EB0A1B2C3D4E5F6"

/** Valid arguments of each tool that names a chat, besides `chat` itself. */
export const ARGUMENTS: Record<string, Record<string, unknown>> = {
  whatsapp_chat_archive: { archived: true },
  whatsapp_chat_mark: { read: true },
  whatsapp_chat_mute: { mute: "always" },
  whatsapp_chat_pin: { pinned: true },
  whatsapp_chat_read: { method: "view" },
  whatsapp_file_save: { id: MESSAGE_ID },
  whatsapp_file_send: { files: [{ path: "note.txt" }] },
  whatsapp_history_backfill: {},
  whatsapp_message_delete: { id: MESSAGE_ID },
  whatsapp_message_edit: { id: MESSAGE_ID, text: "changed" },
  whatsapp_message_react: { id: MESSAGE_ID, emoji: "👍" },
  whatsapp_message_send: { text: "hello" },
}

/** The tools that send to a chat, whose unknown-chat error depends on the JID and on `reply_to`. */
export const SENDS = ["whatsapp_file_send", "whatsapp_message_send"]

/** Every tool whose input names a chat. */
export const chatTools = ALL_TOOLS.filter((spec) => "chat" in spec.input.shape)
