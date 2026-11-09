import { randomBytes } from "node:crypto"
import { lstat, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { ToolError } from "../../errors"
import { DIRECTORY_MODE } from "../constants"
import { ensureDirectory, NotAFolder } from "../fs-safe"

/** How old a folder of an earlier call must be before the next call removes it: a call that crashed left it. */
export const LEFTOVER_AGE_MS = 24 * 60 * 60 * 1000

/** What a call's folder in the outbox is called: 16 random bytes in hexadecimal, which is all this tool makes there. */
const CALL_FOLDER = /^[0-9a-f]{32}$/

/**
 * Removes the folders of earlier calls that are older than `LEFTOVER_AGE_MS`
 * from the outbox. Only real folders named as this tool names its own are
 * touched, and nothing is followed; any failure is ignored, since a leftover
 * is only clutter and must not stop a send.
 */
export async function sweepOutbox(outbox: string, now: number): Promise<void> {
  try {
    for (const name of await readdir(outbox)) {
      if (!CALL_FOLDER.test(name)) continue
      const folder = join(outbox, name)
      try {
        const found = await lstat(folder)
        if (found.isDirectory() && now - found.mtimeMs > LEFTOVER_AGE_MS)
          await rm(folder, { recursive: true, force: true })
      } catch {
        // gone already, or not ours to remove
      }
    }
  } catch {
    // no outbox yet, or it cannot be read
  }
}

/**
 * Makes the outbox if it is missing (0700) and a new, private folder in it for
 * one call, and returns the call's folder. A link or a file where the outbox
 * belongs is `internal_error`; the message names no path.
 */
export async function openCallFolder(outbox: string): Promise<string> {
  try {
    await ensureDirectory(outbox)
  } catch (error) {
    if (error instanceof NotAFolder) {
      throw new ToolError("internal_error", "The account's outbox is not a plain folder; remove it and try again.", {
        cause: error,
      })
    }
    throw error
  }
  const folder = join(outbox, randomBytes(16).toString("hex"))
  await mkdir(folder, { mode: DIRECTORY_MODE })
  return folder
}

/** Removes the folder a call made and everything in it, without following a link; it is fine if it is gone. */
export async function removeCallFolder(folder: string): Promise<void> {
  await rm(folder, { recursive: true, force: true })
}
