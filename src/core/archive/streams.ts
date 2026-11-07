import type { FileHandle } from "node:fs/promises"
import { Readable, pipeline, type Transform } from "node:stream"
import { ArchiveRefused } from "./refused"

/** How much of a file is read at a time. */
export const CHUNK_SIZE = 64 * 1024

/** Reads up to `length` bytes at `position`; fewer only where the file ends. */
export async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

/** Yields `length` bytes of the file from `start` in chunks, fewer if the file ends first. */
export async function* fileChunks(file: FileHandle, start: number, length: number): AsyncGenerator<Uint8Array> {
  for (let done = 0; done < length;) {
    const chunk = await readAt(file, start + done, Math.min(CHUNK_SIZE, length - done))
    if (chunk.length === 0) return
    done += chunk.length
    yield chunk
  }
}

const ZLIB_ERROR_CODE = /^Z_/

function isZlibError(error: unknown): error is Error {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
  return typeof code === "string" && ZLIB_ERROR_CODE.test(code)
}

/**
 * Passes `compressed` through a zlib stream and yields what comes out. What
 * zlib rejects (bad data, input that ends early) becomes the refusal
 * `damaged` makes from zlib's own message; any other failure, such as a read
 * error, passes through. Stopping early destroys the zlib stream and the
 * source.
 */
export async function* inflate(
  compressed: AsyncIterable<Uint8Array>,
  zlib: Transform,
  damaged: (detail: string) => ArchiveRefused,
): AsyncGenerator<Uint8Array> {
  pipeline(Readable.from(compressed, { objectMode: false }), zlib, () => {})
  try {
    for await (const chunk of zlib) yield chunk
  } catch (error) {
    if (isZlibError(error)) throw damaged(error.message)
    throw error
  } finally {
    zlib.destroy()
  }
}

/** The first `count` bytes of a stream, or fewer if it is shorter. */
export async function readHead(stream: AsyncIterable<Uint8Array>, count: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let have = 0
  for await (const chunk of stream) {
    parts.push(chunk)
    have += chunk.length
    if (have >= count) break
  }
  return Buffer.concat(parts).subarray(0, count)
}
