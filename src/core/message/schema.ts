import { z } from "zod"
import { localTimeSchema } from "../time"
import { MESSAGE_TEXT_MAX_CHARACTERS } from "../whatsapp/send"

/** Said by every result: what accepted means, and whose words went out. */
export const SEND_NOTE =
  "Accepted by WhatsApp is not delivered or read. The text sent is exactly the user's, surrounding blank space trimmed."

/** The input schema for `whatsapp_message_send`. */
export const input = z.object({
  account: z.string().optional().describe("The account label; may be left out when only one account is paired."),
  chat: z
    .string()
    .describe(
      "The chat to send to: a person's or a group's JID (…@s.whatsapp.net, …@lid or …@g.us), never a name or a number. Find it with whatsapp_chat_read list; for someone new, the `chat` that whatsapp_contact_read check gives.",
    ),
  text: z
    .string()
    .describe(
      `The text exactly as it should arrive; surrounding blank space is trimmed, and what is left is 1 to ${MESSAGE_TEXT_MAX_CHARACTERS} characters.`,
    ),
  reply_to: z
    .string()
    .optional()
    .describe("The id of a message of that chat to quote, as whatsapp_chat_read gives it."),
})

/** The parsed input to `whatsapp_message_send`. */
export type MessageSendInput = z.output<typeof input>

/** The output schema for `whatsapp_message_send`. */
export const output = z.object({
  chat: z.string().describe("The chat's JID."),
  id: z.string().describe("The sent message's id."),
  time: localTimeSchema.describe("When the send was confirmed as accepted by WhatsApp, in local time with offset."),
  errors: z
    .strictObject({ record: z.string() })
    .optional()
    .describe("Set when the message was sent but could not be written to the mirror; `record` says why."),
  note: z.string().describe("Says that accepted is not delivered or read, and that the text sent is the user's."),
})

/** The result returned by `whatsapp_message_send`. */
export type MessageSendOutput = z.input<typeof output>
