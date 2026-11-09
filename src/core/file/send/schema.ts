import { z } from "zod"
import { MAX_FILES, MAX_TOTAL_BYTES } from "../../outgoing/limits"
import { localTimeSchema } from "../../time"
import { FILE_CAPTION_MAX_CHARACTERS, SEND_AS } from "../../whatsapp/file-send"

const BYTES_PER_MIB = 1024 * 1024

/** The most all the files of one send have together, as a message says it. */
export const TOTAL_SIZE = `${MAX_TOTAL_BYTES / BYTES_PER_MIB} MiB`

/** The pattern of a SHA-256 given as 64 hexadecimal digits, in either case. */
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/

/** Said by every result: what accepted means, and that each file is its own message. */
export const FILE_SEND_NOTE =
  "Accepted by WhatsApp is not delivered or read. Each file went as its own message, in the order given; the text, when there was one, is the caption of the first."

const fileArgument = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe(
      "The file's path, absolute or relative to the working directory; a leading ~ is not expanded. It must be in the working directory or a send directory, and not a key, secret, program or installer.",
    ),
  sha256: z
    .string()
    .regex(SHA256_PATTERN, "must be 64 hexadecimal digits")
    .optional()
    .describe(
      "The SHA-256 of the file as the user approved it, 64 hexadecimal digits. A file that differs is refused as `stale`. Without it the file is sent as it is when the call runs.",
    ),
})

/** The input schema for `whatsapp_file_send`. */
export const input = z.object({
  account: z.string().optional().describe("The account label; may be left out when only one account is paired."),
  chat: z
    .string()
    .describe(
      "The chat to send to: a person's or a group's JID (…@s.whatsapp.net, …@lid or …@g.us), never a name or a number. Find it with whatsapp_chat_read list; for someone new, the `chat` that whatsapp_contact_read check gives.",
    ),
  files: z
    .array(fileArgument)
    .min(1)
    .max(MAX_FILES)
    .describe(
      `1 to ${MAX_FILES} files, each at most once, all together within ${TOTAL_SIZE}. Each goes as its own message, in this order.`,
    ),
  text: z
    .string()
    .optional()
    .describe(
      `A caption for the first file, exactly as it should arrive; surrounding blank space is trimmed, and what is left is at most ${FILE_CAPTION_MAX_CHARACTERS} characters. Never on an audio file. Left out or blank, only the files are sent.`,
    ),
  reply_to: z
    .string()
    .optional()
    .describe("The id of a message of that chat to quote, as whatsapp_chat_read gives it; the first file quotes it."),
  as_document: z
    .boolean()
    .optional()
    .describe(
      "Send every file as a document, at full size, even a photo, a video or audio that WhatsApp would show as such. False when left out.",
    ),
})

/** The parsed input to `whatsapp_file_send`. */
export type FileSendInput = z.output<typeof input>

const sentMessage = z.strictObject({
  name: z.string().describe("The name the file was sent under."),
  id: z.string().describe("The message's id."),
  time: localTimeSchema.describe("When WhatsApp confirmed it as accepted, in local time with offset."),
  as: z.enum(SEND_AS).describe("How WhatsApp showed the file."),
})

const sentFile = z.strictObject({
  path: z.string().describe("The file's real path, with links resolved."),
  name: z.string().describe("The name it was sent under."),
  size: z.number().int().describe("Its size in bytes."),
  sha256: z.string().describe("Its SHA-256 as it was sent, in lower-case hexadecimal."),
})

/** A message of a send, as a result and an error's details give it. */
export type SentMessage = z.infer<typeof sentMessage>

/** The output schema for `whatsapp_file_send`. */
export const output = z.object({
  chat: z.string().describe("The chat's JID."),
  messages: z.array(sentMessage).describe("The messages WhatsApp accepted, one per file, in the order given."),
  files: z.array(sentFile).describe("The files that were sent, in the order given."),
  errors: z
    .strictObject({ record: z.string() })
    .optional()
    .describe("Set when a file was sent but could not be written to the mirror; `record` says which files and why."),
  note: z.string().describe("Says that accepted is not delivered or read, and that each file is its own message."),
})

/** The result returned by `whatsapp_file_send`. */
export type FileSendOutput = z.input<typeof output>
