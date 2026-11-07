import { z } from "zod"

const entry = z.strictObject({
  name: z.string().describe("The entry's path in the archive, cleaned of control and invisible characters."),
  size: z.number().int(),
  dir: z.literal(true).optional().describe("Set for a directory."),
})

const archive = z.strictObject({
  format: z.enum(["zip", "tar", "tgz"]),
  files: z.number().int().describe("How many entries are files."),
  total_size: z.number().int().describe("The bytes the files unpack to."),
  entries: z.array(entry),
  entries_cut: z
    .literal(true)
    .optional()
    .describe("Set when `entries` lists only the first entries, to keep the result short; `files` counts them all."),
})

const savedFile = z.strictObject({
  name: z.string().describe("The name it is saved under, which may differ from the one it was sent with."),
  path: z.string().describe("Where it is saved."),
  type: z.string().optional().describe("The content type its sender gave it."),
  size: z.number().int().describe("Its size in bytes."),
  sha256: z.string().describe("Its SHA-256, in lower-case hexadecimal."),
  already_saved: z.literal(true).optional().describe("Set when the same file was already there and was kept."),
  archive: archive.optional().describe("What an archive holds, after inspection."),
  unpacked: z.string().optional().describe("The folder an archive was unpacked into."),
  already_unpacked: z
    .literal(true)
    .optional()
    .describe("Set when that folder was already there and nothing was written."),
})

export const output = z.strictObject({
  chat: z.string(),
  id: z.string(),
  folder: z.string().describe("The folder the message's file is saved in."),
  file: savedFile.optional().describe("The saved file; absent when it was refused."),
  refused: z
    .strictObject({ name: z.string(), reason: z.string() })
    .optional()
    .describe(
      "Set instead of `file` when the file was not saved, with the reason: a program, an installer, a risky archive.",
    ),
  note: z.string(),
  errors: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Steps that failed after the file was saved, keyed by step: `quarantine`, `unpack:<name>`; what was saved stays.",
    ),
})

/** What the tool returns. */
export type FileSaveOutput = z.infer<typeof output>
export type SavedFile = NonNullable<FileSaveOutput["file"]>
