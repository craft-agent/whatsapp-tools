import { z } from "zod"
import { localTimeSchema } from "../../time"
import { MAX_EMOJI_UNITS } from "../emoji"

/** Said by every result: what accepted means, and what the chat shows now. */
export const REACT_NOTE =
  "Accepted by WhatsApp is not delivered or seen. A reaction replaces the user's earlier one on the message."

/** The input schema for `whatsapp_message_react`. */
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
      "The id of the message to react to, as whatsapp_chat_read gives it: the user's own message or someone else's, but not a call or a vote on a poll.",
    ),
  emoji: z
    .string()
    .optional()
    .describe(
      `Exactly one emoji to react with, at most ${MAX_EMOJI_UNITS} characters; it replaces the user's earlier reaction on the message. Give it or \`remove: true\`, never both and never neither.`,
    ),
  remove: z
    .boolean()
    .optional()
    .describe(
      "Set to true to take the user's reaction off the message, instead of giving `emoji`. Give it or `emoji`, never both and never neither.",
    ),
})

/** The parsed input to `whatsapp_message_react`. */
export type MessageReactInput = z.output<typeof input>

/** The output schema for `whatsapp_message_react`. */
export const output = z.object({
  chat: z.string().describe("The chat's JID."),
  id: z.string().describe("The id of the message that was reacted to."),
  emoji: z.string().nullable().describe("The emoji the user now reacts with, or null when the reaction was removed."),
  time: localTimeSchema.describe("When the reaction was confirmed as accepted by WhatsApp, in local time with offset."),
  errors: z
    .strictObject({ record: z.string() })
    .optional()
    .describe("Set when the reaction was accepted but could not be written to the mirror; `record` says why."),
  note: z
    .string()
    .describe("Says that accepted is not delivered or seen, and that a reaction replaces the earlier one."),
})

/** The result returned by `whatsapp_message_react`. */
export type MessageReactOutput = z.input<typeof output>
