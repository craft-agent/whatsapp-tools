import type { ByteBudget } from "./budget"
import type { ByteReader } from "./byte-reader"
import { cleanName } from "./clean-name"
import { decodeUtf8, decodeUtf8Lossy } from "./encoding"
import type { ArchiveLimits } from "./limits"
import type { RawEntry } from "./raw-entry"
import { ArchiveRefused, damaged } from "./refused"
import {
  TAR_BLOCK_SIZE,
  checksumMatches,
  isZeroBlock,
  parseDecimal,
  parseHeader,
  parsePaxRecords,
  trimNul,
  type PaxRecord,
} from "./tar-header"

/** The most a header's data may take (a pax record set or a GNU long name), far above any path the checks allow. */
const MAX_EXTENDED_HEADER = 64 * 1024

/** How many headers of any kind a tar may have, as a multiple of the entry limit: room for each entry to bring a pax header or a long name. */
const MAX_HEADERS_PER_ENTRY = 2

/** The most records one pax header may hold; the rest of a header's 64 KiB would otherwise be parsed and kept. */
const MAX_PAX_RECORDS = 64

const TYPE_FILE = 0x30
const TYPE_FILE_OLD = 0x00
const TYPE_DIRECTORY = 0x35
const TYPE_PAX = 0x78
const TYPE_PAX_GLOBAL = 0x67
const TYPE_LONG_NAME = 0x4c
const TYPE_LONG_LINK = 0x4b

/** The types that are refused by what they are, which a name alone could not say. */
const REFUSED_TYPES: ReadonlyMap<number, string> = new Map([
  [0x31, "a hard link"],
  [0x32, "a symbolic link"],
  [0x33, "a device file"],
  [0x34, "a device file"],
  [0x36, "a named pipe"],
  [0x37, "a contiguous file, which cannot be read"],
  [0x53, "a sparse file"],
])

/** The pax keys a global header may set: they change nothing about which paths are written or how much. */
const HARMLESS_GLOBAL_KEYS: ReadonlySet<string> = new Set([
  "comment",
  "mtime",
  "atime",
  "ctime",
  "uid",
  "gid",
  "uname",
  "gname",
  "charset",
])
const SPARSE_KEY_PREFIX = "GNU.sparse"
const HEADER_CHARSET_KEY = "hdrcharset"
const UTF8_CHARSET = "ISO-IR 10646 2000 UTF-8"

function ended(): ArchiveRefused {
  return damaged("it ends early")
}

function notTar(): ArchiveRefused {
  return damaged("it is not a tar archive")
}

function paddingAfter(size: number): number {
  return (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
}

/** Reads the data of an extended header and the padding after it, all of it counted against the metadata budget. */
async function readExtended(reader: ByteReader, budget: ByteBudget, size: number | undefined): Promise<Uint8Array> {
  if (size === undefined || size > MAX_EXTENDED_HEADER) throw damaged("an extended header is too large")
  budget.take(size + paddingAfter(size))
  const data = await reader.read(size)
  if (data.length < size) throw ended()
  await reader.skip(paddingAfter(size))
  return data
}

/** What an extended header says that the reader acts on, by key; the other records are counted and ignored. */
type PaxFields = Map<string, Uint8Array>

const ACTED_ON_KEYS: ReadonlySet<string> = new Set(["path", "size"])

/** Reads a pax header's records, refusing a malformed one, one with too many records, and the keys that change what an entry is. */
function readPaxRecords(data: Uint8Array): PaxRecord[] {
  const records = parsePaxRecords(data, MAX_PAX_RECORDS)
  if (records === undefined) {
    throw damaged(`an extended header is malformed or holds more than ${MAX_PAX_RECORDS} records`)
  }
  for (const { key, value } of records) {
    if (key.startsWith(SPARSE_KEY_PREFIX)) throw new ArchiveRefused("the archive holds a sparse file")
    if (key === HEADER_CHARSET_KEY && decodeUtf8Lossy(value) !== UTF8_CHARSET) {
      throw new ArchiveRefused("the archive writes its names in a character set other than UTF-8")
    }
  }
  return records
}

function paxFields(records: PaxRecord[]): PaxFields {
  return new Map(records.filter(({ key }) => ACTED_ON_KEYS.has(key)).map(({ key, value }) => [key, value]))
}

/** Reads what follows the end marker, which may only be zeros: tar pads an archive out to a record size. */
async function checkNothingFollows(reader: ByteReader, budget: ByteBudget): Promise<void> {
  for await (const chunk of reader.rest()) {
    if (chunk.some((byte) => byte !== 0)) throw new ArchiveRefused("the archive holds data after its end")
    budget.take(chunk.length)
  }
}

/** An entry's name from its bytes, which must be UTF-8: any other reading is a guess that unpacking could make differently. */
function decodeName(bytes: Uint8Array): string {
  const name = decodeUtf8(bytes)
  if (name === undefined) {
    throw new ArchiveRefused("named with bytes that are not valid UTF-8", cleanName(decodeUtf8Lossy(bytes)))
  }
  return name
}

async function* fileData(
  reader: ByteReader,
  size: number,
  budget: ByteBudget,
  metadata: ByteBudget,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of reader.take(size)) {
    budget.take(chunk.length)
    yield chunk
  }
  const padding = paddingAfter(size)
  metadata.take(padding)
  await reader.skip(padding)
}

/**
 * Reads a tar's entries in order: ustar, GNU (long names) and pax (paths and
 * sizes) headers, regular files and directories only. Anything else, a link of
 * either kind, a device, a pipe, a sparse file, is refused when it is reached.
 * The archive ends with two zero blocks; one that stops short of them is
 * damaged, and what follows them is read to the end of the input and may only
 * be zeros (so, for a gzipped tar, every gzip member is read and its checksum
 * checked).
 *
 * File data counts against `budget`; everything else read (headers, extension
 * data, padding, the end marker and the zeros after it) counts against the
 * separate `metadata` budget, so how an archive is laid out never costs the
 * data it may hold. At most `MAX_HEADERS_PER_ENTRY` times the
 * entry limit of headers of any kind (extended and long-name headers too) may
 * appear; an entry has at most one pax header and one long name before it; and
 * a pax header holds at most `MAX_PAX_RECORDS` records, of which only `path`
 * and `size` are kept.
 *
 * Each entry's data must be drained before the next one is asked for, which
 * `walkArchive` does.
 */
export async function* tarEntries(
  reader: ByteReader,
  limits: ArchiveLimits,
  budget: ByteBudget,
  metadata: ByteBudget,
): AsyncGenerator<RawEntry> {
  const maxHeaders = limits.maxEntries * MAX_HEADERS_PER_ENTRY
  let count = 0
  let headers = 0
  let longName: Uint8Array | undefined
  let pax: PaxFields | undefined

  for (let started = false; ; started = true) {
    const block = await reader.read(TAR_BLOCK_SIZE)
    if (block.length < TAR_BLOCK_SIZE) throw started ? ended() : notTar()
    metadata.take(block.length)
    if (isZeroBlock(block)) {
      const second = await reader.read(TAR_BLOCK_SIZE)
      if (second.length === TAR_BLOCK_SIZE && isZeroBlock(second)) {
        metadata.take(second.length)
        await checkNothingFollows(reader, metadata)
        return
      }
      throw started ? ended() : notTar()
    }
    if (!checksumMatches(block)) throw started ? damaged("a header's checksum is wrong") : notTar()
    if (++headers > maxHeaders) throw new ArchiveRefused(`the archive has more than ${maxHeaders} headers`)

    const header = parseHeader(block)
    switch (header.type) {
      case TYPE_PAX:
        if (pax !== undefined) throw new ArchiveRefused("the archive has two extended headers for one entry")
        pax = paxFields(readPaxRecords(await readExtended(reader, metadata, header.size)))
        continue
      case TYPE_PAX_GLOBAL:
        for (const { key } of readPaxRecords(await readExtended(reader, metadata, header.size))) {
          if (!HARMLESS_GLOBAL_KEYS.has(key))
            throw new ArchiveRefused("the archive sets a path or size for every entry")
        }
        continue
      case TYPE_LONG_NAME:
        if (longName !== undefined) throw new ArchiveRefused("the archive has two long names for one entry")
        longName = trimNul(await readExtended(reader, metadata, header.size))
        continue
      case TYPE_LONG_LINK:
        throw new ArchiveRefused("the archive holds a link")
    }

    if (++count > limits.maxEntries) throw new ArchiveRefused(`the archive has more than ${limits.maxEntries} entries`)
    const name = decodeName(pax?.get("path") ?? longName ?? header.path)
    const shown = cleanName(name)
    const declared = pax?.get("size")
    const size = declared === undefined ? header.size : parseDecimal(decodeUtf8Lossy(declared))
    longName = undefined
    pax = undefined

    const refusal = REFUSED_TYPES.get(header.type)
    if (refusal !== undefined) throw new ArchiveRefused(refusal, shown)
    const dir = header.type === TYPE_DIRECTORY
    if (!dir && header.type !== TYPE_FILE && header.type !== TYPE_FILE_OLD) {
      throw new ArchiveRefused(`of a type that cannot be read (0x${header.type.toString(16)})`, shown)
    }
    if (size === undefined) throw damaged(`the size of ${shown} is not a number`)
    if (dir && size !== 0) throw new ArchiveRefused("a directory that holds data", shown)
    if (!dir && name.endsWith("/")) throw new ArchiveRefused("a file named like a directory", shown)

    budget.check(size)
    yield {
      entry: { name: dir && !name.endsWith("/") ? `${name}/` : name, dir, size },
      data: dir ? null : fileData(reader, size, budget, metadata),
    }
  }
}
