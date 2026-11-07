import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises"
import { DIRECTORY_MODE, FILE_MODE } from "./constants"

/** How much of a file is read and written at a time. */
const CHUNK_SIZE = 64 * 1024

/** Makes an open fail on a link in the last component instead of following it. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

/** The flags of a file that must be new: it is made here, 0600, and a name that exists in any form, a link included, is `EEXIST`. */
const CREATE_NEW = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW

/** Creates a file that did not exist (private, never executable); `EEXIST` when the name is taken, also by a link. */
export function createNew(path: string): Promise<FileHandle> {
  return open(path, CREATE_NEW, FILE_MODE)
}

/**
 * Opens a file for reading, refusing to follow a link at its last component
 * (`ELOOP`). `extraFlags` are added to the open flags, such as
 * `constants.O_NONBLOCK`, which makes the open of a FIFO return at once and
 * changes nothing for a regular file.
 */
export function openForRead(path: string, extraFlags = 0): Promise<FileHandle> {
  return open(path, constants.O_RDONLY | NO_FOLLOW | extraFlags)
}

/** The error code of a failed file system call, if it has one. */
export function errorCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  return typeof code === "string" ? code : undefined
}

/**
 * Copies everything from `from` to `to`, handing each chunk to `onChunk`
 * before it is written; a chunk is only valid during the call. Resolves to
 * the number of bytes copied. Stops with the signal's `AbortError` when it
 * aborts.
 */
export async function copyAll(
  from: FileHandle,
  to: FileHandle,
  onChunk: (chunk: Buffer) => void,
  signal?: AbortSignal,
): Promise<number> {
  const buffer = Buffer.alloc(CHUNK_SIZE)
  let total = 0
  for (;;) {
    signal?.throwIfAborted()
    const { bytesRead } = await from.read(buffer, 0, CHUNK_SIZE, null)
    if (bytesRead === 0) return total
    const chunk = buffer.subarray(0, bytesRead)
    onChunk(chunk)
    await writeAll(to, chunk)
    total += bytesRead
  }
}

/** Writes all of `chunk`, however many writes the file system takes for it. */
export async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  for (let written = 0; written < chunk.length;) {
    const { bytesWritten } = await file.write(chunk, written, chunk.length - written, null)
    written += bytesWritten
  }
}

/** The SHA-256 of a regular file, as lower-case hexadecimal; a link at the path is not followed. */
export async function sha256Of(path: string): Promise<string> {
  const file = await openForRead(path)
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(CHUNK_SIZE)
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, CHUNK_SIZE, null)
      if (bytesRead === 0) return hash.digest("hex")
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await file.close()
  }
}

/** What `ensureDirectory` throws when a link or a file stands where a folder should be. */
export class NotAFolder extends Error {
  readonly path: string
  readonly link: boolean

  constructor(path: string, link: boolean) {
    super(
      `"${path}" is ${link ? "a link" : "not a folder"}; nothing is saved or unpacked through a link or over a file.`,
    )
    this.name = "NotAFolder"
    this.path = path
    this.link = link
  }
}

/**
 * Makes sure `path` is a real directory, creating it (0700) when it is
 * missing. A link or a file in its place is `NotAFolder`: nothing is ever
 * saved or unpacked through a link.
 */
export async function ensureDirectory(path: string): Promise<void> {
  let found = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  })
  if (found === undefined) {
    try {
      await mkdir(path, { mode: DIRECTORY_MODE })
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
    found = await lstat(path)
  }
  if (!found.isDirectory()) throw new NotAFolder(path, found.isSymbolicLink())
}
