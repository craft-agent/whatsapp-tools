import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { createGunzip } from "node:zlib"
import { ByteBudget } from "./budget"
import { ByteReader } from "./byte-reader"
import type { ArchiveFormat } from "./kind"
import { DEFAULT_LIMITS, describeSize, type ArchiveLimits } from "./limits"
import type { ArchiveEntry, RawEntry } from "./raw-entry"
import { ArchiveRefused, damaged } from "./refused"
import { fileChunks, inflate } from "./streams"
import { tarEntries } from "./tar"
import { zipEntries } from "./zip"

/**
 * What a handler is given for an entry's data: it yields the file's bytes
 * once. A handler may stop reading early; `walkArchive` reads the rest itself,
 * so every byte is counted and checked.
 */
export type EntryData = AsyncIterable<Uint8Array>

/** Called for each entry in the archive's order, with its data when it is a file and `null` when it is a directory. */
export type EntryHandler = (entry: ArchiveEntry, data: EntryData | null) => Promise<void>

/** Hands out a generator's values to one reader, whose early stop leaves the rest for `walkArchive` to drain. */
function shared(data: AsyncGenerator<Uint8Array>, signal?: AbortSignal): EntryData {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        signal?.throwIfAborted()
        return data.next()
      },
      return: async (): Promise<IteratorReturnResult<undefined>> => ({ done: true, value: undefined }),
    }),
  }
}

/**
 * Stops a decompressed stream that grows past `cap`, however it is packed: a
 * bomb is cut off by the bytes it produces, whatever the budgets would say
 * of them.
 */
async function* capped(source: AsyncIterable<Uint8Array>, cap: number): AsyncGenerator<Uint8Array> {
  let count = 0
  for await (const chunk of source) {
    count += chunk.length
    if (count > cap) throw new ArchiveRefused(`the archive unpacks to more than ${describeSize(cap)}`)
    yield chunk
  }
}

/** Opens the archive for reading, refusing a link at its path and anything that is not a regular file. */
async function openRegularFile(path: string): Promise<FileHandle> {
  let file: FileHandle
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if ((error as { code?: unknown }).code === "ELOOP") throw new ArchiveRefused("the archive is a link, not a file")
    throw error
  }
  if (!(await file.stat()).isFile()) {
    await file.close()
    throw new ArchiveRefused("the archive is not a regular file")
  }
  return file
}

/**
 * Reads an archive's entries in order and gives each to `onEntry` with its
 * data once, counting every byte as it comes: the entry count, each entry's
 * declared size and the whole archive's size are held to what is read, not to
 * what the archive claims. An archive file over `maxInputSize` is refused
 * before any of it is read. An entry's data is drained and checked after the
 * handler returns, whether or not the handler read it. A refusal is an
 * `ArchiveRefused`; a handler's own error stops the walk and passes through.
 *
 * The input is opened without following a link at its path and must be a
 * regular file (checked on the open file, not the path), so what is read is
 * what the caller put there. `signal` is checked before each chunk of data is
 * read and each entry is started, and stops the walk with its `AbortError`.
 */
export async function walkArchive(
  path: string,
  format: ArchiveFormat,
  onEntry: EntryHandler,
  limits: ArchiveLimits = DEFAULT_LIMITS,
  signal?: AbortSignal,
): Promise<void> {
  const file = await openRegularFile(path)
  let reader: ByteReader | undefined
  try {
    const { size } = await file.stat()
    if (size > limits.maxInputSize) {
      throw new ArchiveRefused(`the archive file is larger than ${describeSize(limits.maxInputSize)}`)
    }
    const budget = ByteBudget.forData(limits.maxTotalSize)
    let entries: AsyncGenerator<RawEntry>
    if (format === "zip") {
      entries = zipEntries(file, size, limits, budget)
    } else {
      const bytes = fileChunks(file, 0, size)
      const stream =
        format === "tgz"
          ? capped(inflate(bytes, createGunzip(), damaged), limits.maxTotalSize + limits.maxMetadata)
          : bytes
      reader = new ByteReader(stream, () => damaged("it ends early"), signal)
      entries = tarEntries(reader, limits, budget, ByteBudget.forMetadata(limits.maxMetadata))
    }

    for await (const { entry, data } of entries) {
      try {
        signal?.throwIfAborted()
        await onEntry(entry, data && shared(data, signal))
        while (data) {
          signal?.throwIfAborted()
          if ((await data.next()).done) break
        }
      } finally {
        await data?.return(undefined)
      }
    }
  } finally {
    await reader?.close()
    await file.close()
  }
}
