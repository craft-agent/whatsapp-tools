import { z } from "zod"
import { MS_PER_MINUTE, localTimeSchema } from "../../time"
import { MESSAGE_TEXT_MAX_CHARACTERS } from "../../whatsapp/send"

/** How long after it was sent WhatsApp lets the user edit a message. */
export const EDIT_WINDOW_MS = 15 * MS_PER_MINUTE

/** The limit of `EDIT_WINDOW_MS` in the words a refusal and a description use. */
export const EDIT_WINDOW = "15 minutes"

/** Said by every result: what accepted means, and what the chat shows now. */
export const EDIT_NOTE =
  "Accepted by WhatsApp is not delivered or seen. The chat shows the new text marked as edited; the earlier text is gone from it."

/** The input schema for `whatsapp_message_edit`. */
export const input = z.object({
  account: z.string().optional().describe("The account label; may be left out when only one account is paired."),
  chat: z
    .string()
    .describe(
      "The chat the message is in: a person's or a group's JID (…@s.whatsapp.net, …@lid or …@g.us), as whatsapp_chat_read gives it, never a name or a number.",
    ),
  id: z
    .string()
    .describe("The id of the message to edit, as whatsapp_chat_read gives it: a text message the user sent."),
  text: z
    .string()
    .describe(
      `The new text exactly as it should read; surrounding blank space is trimmed, and what is left is 1 to ${MESSAGE_TEXT_MAX_CHARACTERS} characters.`,
    ),
})

/** The parsed input to `whatsapp_message_edit`. */
export type MessageEditInput = z.output<typeof input>

/** The output schema for `whatsapp_message_edit`. */
export const output = z.object({
  chat: z.string().describe("The chat's JID."),
  id: z.string().describe("The edited message's id."),
  time: localTimeSchema.describe("When the edit was confirmed as accepted by WhatsApp, in local time with offset."),
  errors: z
    .strictObject({ record: z.string() })
    .optional()
    .describe("Set when the edit was accepted but the new text could not be written to the mirror; `record` says why."),
  note: z.string().describe("Says that accepted is not delivered or seen, and what the chat shows now."),
})

/** The result returned by `whatsapp_message_edit`. */
export type MessageEditOutput = z.input<typeof output>
