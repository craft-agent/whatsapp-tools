import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { ToolError } from "../errors"
import { openForRead } from "./fs-safe"

const NOT_STAGED = "The download left no regular file to save."

/**
 * Opens the file a download was asked to write, and nothing else: a link at the path is not followed, a FIFO does
 * not make the open wait, and what is there must be a regular file. `upstream_error` otherwise; the path never
 * appears in the error.
 */
export async function openStaged(path: string): Promise<FileHandle> {
  let file: FileHandle
  try {
    file = await openForRead(path, constants.O_NONBLOCK)
  } catch (error) {
    throw new ToolError("upstream_error", NOT_STAGED, { cause: error })
  }
  try {
    if ((await file.stat()).isFile()) return file
  } catch {
    // treated as not readable, below
  }
  await file.close()
  throw new ToolError("upstream_error", NOT_STAGED)
}
