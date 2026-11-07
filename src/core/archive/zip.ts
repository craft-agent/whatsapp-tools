import type { FileHandle } from "node:fs/promises"
import { createInflateRaw, crc32 } from "node:zlib"
import type { ByteBudget } from "./budget"
import type { ArchiveLimits } from "./limits"
import type { RawEntry } from "./raw-entry"
import { ArchiveRefused, damaged } from "./refused"
import { fileChunks, inflate, readAt } from "./streams"
import { readCentralRecords, readDirectory, type CentralRecord, type ZipDirectory } from "./zip-directory"
import { ENCRYPTION_FLAGS, readLocal } from "./zip-local"

const METHOD_STORED = 0
const METHOD_DEFLATED = 8

const DOS_DIRECTORY = 0x10
const UNIX_TYPE_MASK = 0xf000
const UNIX_REGULAR = 0x8000
const UNIX_DIRECTORY = 0x4000
const UNIX_SYMLINK = 0xa000
const MODE_SHIFT = 16

/** Refuses an entry that is encrypted, uses another method, or is anything but a plain file or directory. */
function checkKind(record: CentralRecord): boolean {
  const { shown } = record
  if ((record.flags & ENCRYPTION_FLAGS) !== 0) throw new ArchiveRefused("encrypted", shown)
  if (record.method !== METHOD_STORED && record.method !== METHOD_DEFLATED) {
    throw new ArchiveRefused(`compressed with method ${record.method}, which cannot be read`, shown)
  }
  if (record.hasUnicodePath) throw new ArchiveRefused("named twice, by a second name field", shown)

  const type = (record.externalAttributes >>> MODE_SHIFT) & UNIX_TYPE_MASK
  if (type === UNIX_SYMLINK) throw new ArchiveRefused("a symbolic link", shown)
  if (type !== 0 && type !== UNIX_REGULAR && type !== UNIX_DIRECTORY) {
    throw new ArchiveRefused("a special file (a device, pipe or socket)", shown)
  }

  const dir = record.name.endsWith("/")
  if (!dir && (type === UNIX_DIRECTORY || (record.externalAttributes & DOS_DIRECTORY) !== 0)) {
    throw new ArchiveRefused("a directory that is not named like one", shown)
  }
  if (dir && (record.size !== 0 || (record.method === METHOD_STORED && record.compressedSize !== 0))) {
    throw new ArchiveRefused("a directory that holds data", shown)
  }
  if (!dir && record.method === METHOD_STORED && record.compressedSize !== record.size) {
    throw damaged(`the sizes of ${shown} disagree`)
  }
  return dir
}

/** An entry with the bytes it takes up: `start` to `end` from its local header to the end of any data descriptor. */
type Located = { record: CentralRecord; dir: boolean; start: number; end: number; dataStart: number }

/** Checks each record, reads its local header, which must agree with the central one, and finds where its bytes lie. */
async function locate(file: FileHandle, records: CentralRecord[], directory: ZipDirectory): Promise<Located[]> {
  const located: Located[] = []
  for (const record of records) {
    const dir = checkKind(record)
    const { dataStart, end } = await readLocal(file, record, directory.offset)
    located.push({ record, dir, start: record.localOffset, end, dataStart })
  }
  return located
}

/**
 * Refuses entries whose bytes overlap, which is how one stretch of data is
 * made to read as several files, and any stretch of the file before the
 * central directory that no entry accounts for: prepended data, an orphan
 * local entry, bytes between entries. What the directory does not list could
 * be read as an entry by a program that scans local headers instead.
 */
function checkCoverage(located: Located[], directory: ZipDirectory): void {
  const unaccounted = () => new ArchiveRefused("the archive holds data its directory does not account for")
  let position = 0
  for (const item of [...located].sort((a, b) => a.start - b.start)) {
    if (item.start < position) throw new ArchiveRefused("overlapping another entry", item.record.shown)
    if (item.start > position) throw unaccounted()
    position = item.end
  }
  if (position !== directory.offset) throw unaccounted()
}

/**
 * The entry's bytes, counted as they come: more than the entry declares, or
 * than the archive may unpack to, stops it at once; fewer, or a checksum that
 * differs, is found at its end. A deflate stream must end exactly where the
 * entry's compressed data does. A directory's data goes through here too, and
 * must come out empty.
 */
async function* entryData(
  file: FileHandle,
  { record, dataStart }: Located,
  budget: ByteBudget,
): AsyncGenerator<Uint8Array> {
  const stored = fileChunks(file, dataStart, record.compressedSize)
  const zlib = createInflateRaw()
  const source =
    record.method === METHOD_STORED
      ? stored
      : inflate(stored, zlib, (detail) => new ArchiveRefused(`damaged (${detail})`, record.shown))
  let count = 0
  let crc = 0
  for await (const chunk of source) {
    count += chunk.length
    if (count > record.size) throw new ArchiveRefused("larger than the archive says", record.shown)
    budget.take(chunk.length)
    crc = crc32(chunk, crc)
    yield chunk
  }
  if (count !== record.size) throw new ArchiveRefused("smaller than the archive says", record.shown)
  if (crc !== record.crc) throw new ArchiveRefused("damaged (its checksum does not match)", record.shown)
  if (record.method === METHOD_DEFLATED && zlib.bytesWritten !== record.compressedSize) {
    throw new ArchiveRefused("damaged (its compressed data goes on after the end of the stream)", record.shown)
  }
}

/**
 * Reads a zip's entries in the order of its central directory. The directory
 * is read and every entry checked, down to its local header and the way the
 * entries tile the file, before the first one is yielded; the sizes the
 * archive declares are never trusted, only the bytes that come out of each
 * entry.
 */
export async function* zipEntries(
  file: FileHandle,
  fileSize: number,
  limits: ArchiveLimits,
  budget: ByteBudget,
): AsyncGenerator<RawEntry> {
  const directory = await readDirectory(file, fileSize, limits)
  const records = readCentralRecords(await readAt(file, directory.offset, directory.size), directory.count)
  const located = await locate(file, records, directory)
  checkCoverage(located, directory)
  budget.check(located.reduce((sum, { record }) => sum + record.size, 0))
  for (const item of located) {
    const entry = { name: item.record.name, dir: item.dir, size: item.record.size }
    if (item.dir) {
      // A directory has no data, which is checked the way a file's is: its stream must be empty, with checksum 0, and end where the entry does
      for await (const _chunk of entryData(file, item, budget)) continue
      yield { entry, data: null }
    } else {
      yield { entry, data: entryData(file, item, budget) }
    }
  }
}
