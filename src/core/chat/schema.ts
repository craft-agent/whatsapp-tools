import { z } from "zod"
import type { LimitRule } from "../pages"
import { localTimeSchema } from "../time"
import { chatRef, messageEntry } from "./message-schema"

/** The methods of `whatsapp_chat_read`. */
export const METHODS = ["list", "view"] as const
/** A method supported by `whatsapp_chat_read`. */
export type Method = (typeof METHODS)[number]

/** The default and the largest `limit` of each method that pages. */
export const LIMITS = {
  list: { default: 30, max: 200 },
  view: { default: 50, max: 300 },
} as const satisfies Partial<Record<Method, LimitRule>>

/** How many of a chat's latest rows `list` with `last` looks through for a message. */
export const LAST_MESSAGE_ROWS = 20

/** The input schema for `whatsapp_chat_read`. */
export const input = z.object({
  method: z
    .enum(METHODS)
    .describe("`list` finds chats; `view` reads the newest messages of one chat between two times, oldest first."),
  account: z.string().optional().describe("The account label; may be left out when only one account is paired."),
  query: z
    .string()
    .optional()
    .describe("list: only chats whose name or JID holds this text. wacli ignores case; the text is not a pattern."),
  unread: z.boolean().optional().describe("list: only chats marked unread or holding unread messages."),
  last: z
    .boolean()
    .optional()
    .describe(
      `list: add each chat's last real message as \`last_message\`. It looks past rows wacli could not read, but only through the chat's latest ${LAST_MESSAGE_ROWS} rows; it is null when none of them is a message.`,
    ),
  chat: z
    .string()
    .optional()
    .describe(
      "view (required): the chat's JID, from `list`: …@s.whatsapp.net for a person, …@lid for a contact whose number is hidden, …@g.us, …@newsletter or …@broadcast. A name or a number is not a chat.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "view: only messages after this time (exclusive): RFC 3339 with an offset, or a date or time without one, read as local time, such as 2026-11-07 or 2026-11-07T14:03.",
    ),
  before: z
    .string()
    .optional()
    .describe("view: only messages before this time (exclusive); the same forms as `after`."),
  limit: z
    .number()
    .int()
    .optional()
    .describe(
      `How many to return. list: default ${LIMITS.list.default}, at most ${LIMITS.list.max}. view: default ${LIMITS.view.default}, at most ${LIMITS.view.max}. A larger value is lowered to the most; a result may hold fewer to stay a size a model can read.`,
    ),
  cursor: z.string().optional().describe("The `next` of the previous result, to continue where it stopped."),
})

/** The parsed input to `whatsapp_chat_read`. */
export type ChatReadInput = z.output<typeof input>

const chatEntry = chatRef.extend({
  unread: z.number().describe("Incoming messages not read yet, as wacli counts them."),
  marked_unread: z
    .literal(true)
    .optional()
    .describe("Set when the chat is marked unread but wacli counts no unread message."),
  archived: z.literal(true).optional(),
  pinned: z.literal(true).optional(),
  muted: z.literal(true).optional().describe("Set while the chat is muted."),
  last_activity_at: localTimeSchema
    .nullable()
    .describe(
      "The chat's last activity in local time with offset, or null. wacli sets it from any row of the chat, which may not be a message, so it is not the time of a message.",
    ),
  last_message: messageEntry.nullable().optional().describe("With `last`: the chat's last real message, or null."),
})

/** One chat in a `list` result. */
export type ChatEntry = z.infer<typeof chatEntry>

/** The output schema for `whatsapp_chat_read`. */
export const output = z.object({
  chats: z.array(chatEntry).optional().describe("list: the chats, newest activity first."),
  chat: chatRef.optional().describe("view: the chat read."),
  messages: z.array(messageEntry).optional().describe("view: the messages, oldest first."),
  unreadable_rows: z
    .number()
    .optional()
    .describe(
      "view: how many rows wacli keeps for protocol traffic it could not read (no text, media, reaction or quote) were left out of this page; absent when none.",
    ),
  next: z.string().optional().describe("Pass back as `cursor` to continue; absent when there is no more."),
  note: z.string().describe("Says that what the result carries is data written by other people."),
})

/** The result returned by `whatsapp_chat_read`. */
export type ChatReadOutput = z.input<typeof output>
