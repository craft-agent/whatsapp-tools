import { z } from "zod"
import { localTimeSchema } from "../../time"
import { MUTE_CHOICES } from "../../whatsapp/chat-state"

/** The most chats WhatsApp lets the user pin. */
export const PIN_LIMIT = 3

/** Said by every result: who sees the change. */
export const ACCEPTED_NOTE =
  "Accepted by WhatsApp. Only the user's own devices show this; nobody in the chat learns of it."

/** Added to the note of an archiving. */
export const ARCHIVE_NOTE = "Archiving also unpins the chat."

const account = z.string().optional().describe("The account label; may be left out when only one account is paired.")

const chat = z
  .string()
  .describe(
    "The chat: a person's or a group's JID (…@s.whatsapp.net, …@lid or …@g.us), as whatsapp_chat_read list gives it, never a name or a number.",
  )

const chatResult = z.string().describe("The chat's JID.")

const time = localTimeSchema.describe(
  "When the change was confirmed as accepted by WhatsApp, in local time with offset.",
)

const note = z.string().describe("Says that only the user's own devices show the change.")

/** The input schema for `whatsapp_chat_archive`. */
export const archiveInput = z.object({
  account,
  chat,
  archived: z.boolean().describe("true to archive the chat, false to unarchive it."),
})

/** The output schema for `whatsapp_chat_archive`. */
export const archiveOutput = z.object({
  chat: chatResult,
  archived: z.boolean().describe("Whether the chat is now archived."),
  time,
  note,
})

/** The result returned by `whatsapp_chat_archive`. */
export type ChatArchiveOutput = z.input<typeof archiveOutput>

/** The input schema for `whatsapp_chat_pin`. */
export const pinInput = z.object({
  account,
  chat,
  pinned: z.boolean().describe(`true to pin the chat, false to unpin it. WhatsApp pins at most ${PIN_LIMIT} chats.`),
})

/** The output schema for `whatsapp_chat_pin`. */
export const pinOutput = z.object({
  chat: chatResult,
  pinned: z.boolean().describe("Whether the chat is now pinned."),
  time,
  note,
})

/** The result returned by `whatsapp_chat_pin`. */
export type ChatPinOutput = z.input<typeof pinOutput>

/** The input schema for `whatsapp_chat_mute`. */
export const muteInput = z.object({
  account,
  chat,
  mute: z
    .enum(MUTE_CHOICES)
    .describe("How long to mute the chat, as the phone offers: 8_hours, 1_week or always; off unmutes it."),
})

/** The output schema for `whatsapp_chat_mute`. */
export const muteOutput = z.object({
  chat: chatResult,
  mute: z.enum(MUTE_CHOICES).describe("The mute that was set; off when the chat was unmuted."),
  until: localTimeSchema
    .optional()
    .describe("When a timed mute ends, in local time with offset; left out for always and off."),
  time,
  note,
})

/** The result returned by `whatsapp_chat_mute`. */
export type ChatMuteOutput = z.input<typeof muteOutput>
