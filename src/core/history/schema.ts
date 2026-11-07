import { z } from "zod"
import { localTimeSchema } from "../time"
import { BACKFILL_BATCHES, BACKFILL_COUNT, BACKFILL_STOPPED } from "../whatsapp/backfill"

/** Said by every result: asking the phone is best effort, and what a result of nothing does not prove. */
export const BACKFILL_NOTE =
  "Asking the phone for older messages is best effort: the phone must be online, and nothing added does not prove that nothing older exists. Asking again is safe."

/** The input schema for `whatsapp_history_backfill`. */
export const input = z.object({
  account: z.string().optional().describe("The account label; may be left out when only one account is paired."),
  chat: z
    .string()
    .describe(
      "The chat to ask the phone for older messages of: its JID (…@s.whatsapp.net, …@lid, …@g.us, …@newsletter or …@broadcast), never a name or a number. Find it with whatsapp_chat_read list. The mirror must already hold a message of the chat.",
    ),
  batches: z
    .number()
    .int()
    .min(1)
    .max(BACKFILL_BATCHES.max)
    .optional()
    .describe(
      `How many batches of up to ${BACKFILL_COUNT} older messages to ask the phone for, 1 to ${BACKFILL_BATCHES.max}, default ${BACKFILL_BATCHES.default}. Each batch asks from the oldest message the mirror holds and can take up to a minute or more.`,
    ),
})

/** The parsed input to `whatsapp_history_backfill`. */
export type HistoryBackfillInput = z.output<typeof input>

/** The output schema for `whatsapp_history_backfill`. */
export const output = z.object({
  chat: z.string().describe("The chat's JID."),
  added: z
    .number()
    .int()
    .describe("How many messages of the chat the mirror gained; 0 does not prove there is nothing older."),
  held: z.number().int().describe("How many messages of the chat the mirror holds now."),
  oldest: localTimeSchema
    .nullable()
    .describe("The time of the oldest message the mirror holds of the chat, in local time with its offset."),
  stopped: z
    .enum(BACKFILL_STOPPED)
    .describe(
      "Why it ended: batches_done (every batch asked), start_of_history (the phone has nothing older), nothing_older (the phone sent nothing older than the mirror holds), no_answer (the phone stopped answering), time_limit (the time ran out) or error (wacli failed after some messages arrived).",
    ),
  service_running: z
    .boolean()
    .describe(
      "Whether the account's sync service syncs again; false means it did not start again and the mirror receives nothing until the service is started.",
    ),
  note: z.string().describe("Says that asking is best effort and that asking again is safe."),
})

/** The result returned by `whatsapp_history_backfill`. */
export type HistoryBackfillOutput = z.input<typeof output>
