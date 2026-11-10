import { z } from "zod"
import { MS_PER_MINUTE, localTimeSchema } from "../../time"

/** How long after it was sent WhatsApp lets the user delete a message for everyone. */
export const DELETE_WINDOW_MS = 2 * 24 * 60 * MS_PER_MINUTE

/** The limit of `DELETE_WINDOW_MS` in the words a refusal and a description use. */
export const DELETE_WINDOW = "two days"

/** Said by every result: what accepted means, what the devices show, and that nothing brings the message back. */
export const DELETE_NOTE =
  "Accepted by WhatsApp is not delivered. Devices show the message as deleted; one that is offline gets it later, and nothing can bring it back."

/** The input schema for `whatsapp_message_delete`. */
export const input = z.object({
  account: z.string().optional().describe("The account label; may be left out when only one account is paired."),
  chat: z
    .string()
    .describe(
      "The chat the message is in: a person's or a group's JID (…@s.whatsapp.net, …@lid or …@g.us), as whatsapp_chat_read gives it, never a name or a number.",
    ),
  id: z
    .string()
    .describe(
      "The id of the message to delete for everyone, as whatsapp_chat_read gives it: a message the user sent, of any kind but a call.",
    ),
})

/** The parsed input to `whatsapp_message_delete`. */
export type MessageDeleteInput = z.output<typeof input>

/** The output schema for `whatsapp_message_delete`. */
export const output = z.object({
  chat: z.string().describe("The chat's JID."),
  id: z.string().describe("The deleted message's id."),
  deleted: z.literal(true).describe("Always true: WhatsApp accepted the deletion."),
  time: localTimeSchema.describe("When the deletion was confirmed as accepted by WhatsApp, in local time with offset."),
  service_running: z
    .boolean()
    .describe(
      "Whether the account's sync service syncs again; false means it did not start again and the mirror receives nothing until the service is started.",
    ),
  errors: z
    .strictObject({ record: z.string() })
    .optional()
    .describe("Set when the deletion was accepted but could not be written to the mirror; `record` says why."),
  note: z
    .string()
    .describe("Says that accepted is not delivered, what devices show now, and that it cannot be undone."),
})

/** The result returned by `whatsapp_message_delete`. */
export type MessageDeleteOutput = z.input<typeof output>
