import { crc32, deflateRawSync } from "node:zlib"

/** A data descriptor after an entry's data, which sets the descriptor flag and leaves the local header's checksum and sizes zero. */
export type ZipDescriptor = {
  /** Writes the `PK\7\8` signature. Default `true`. */
  signature?: boolean
  /** Writes 64-bit sizes. Default `false`. */
  wide?: boolean
  /** Written in place of the entry's checksum and sizes, to write a descriptor that disagrees. */
  crc?: number
  size?: number
  compressedSize?: number
}

/**
 * One entry for `buildZip`. `crc`, `size` and `compressedSize` overrides write
 * a lie into the local header and the central record alike, so the lie is
 * consistent; `local` writes into the local header alone, to disagree with the
 * central record.
 */
export type ZipEntry = {
  name: string | Buffer
  data?: Buffer | string
  /** `stored` or `deflate`, or any other method number, which writes the data as it is. Default `deflate`. */
  method?: "stored" | "deflate" | number
  /** A directory: the name gets a trailing `/` and the entry is empty. */
  dir?: boolean
  flags?: number
  /** The external attributes: the Unix mode is in the high 16 bits. */
  attributes?: number
  /** Sets the UTF-8 name flag; on by default for a name with anything but ASCII. */
  utf8?: boolean
  crc?: number
  size?: number
  compressedSize?: number
  localName?: string | Buffer
  localOffset?: number
  /** Saturates the 32-bit fields of the central record and carries the real values in a zip64 extra field. */
  zip64?: boolean
  /** Extra field bytes added to the central record. */
  extra?: Buffer
  /** What the local header alone says; fields left out follow the central record. */
  local?: { flags?: number; crc?: number; size?: number; compressedSize?: number; extra?: Buffer }
  descriptor?: ZipDescriptor
  /** Bytes written before the entry's local header, which the directory does not account for. */
  before?: Buffer
}

export type ZipOptions = {
  /** Bytes written between the last entry and the central directory. */
  beforeDirectory?: Buffer
  /** Writes the zip64 end record and its locator, and saturates the end record's fields. */
  zip64?: boolean
  /** With `zip64`, writes these values (or all the real ones, for `"real"`) in the classic end record instead of saturating it. */
  classic?: "real" | { entries?: number; size?: number; offset?: number }
  comment?: string
}

const SATURATED_16 = 0xffff
const SATURATED_32 = 0xffffffff
const UNIX_VERSION = 0x031e
const REGULAR_FILE_MODE = 0o100644
const DIRECTORY_MODE = 0o040755
const DOS_DATE = 0x21

function bytes(text: string | Buffer): Buffer {
  return typeof text === "string" ? Buffer.from(text) : text
}

function fields(...parts: Array<[width: 2 | 4 | 8, value: number | bigint]>): Buffer {
  const out = Buffer.alloc(parts.reduce((sum, [width]) => sum + width, 0))
  let at = 0
  for (const [width, value] of parts) {
    if (width === 2) out.writeUInt16LE(Number(value), at)
    else if (width === 4) out.writeUInt32LE(Number(value), at)
    else out.writeBigUInt64LE(BigInt(value), at)
    at += width
  }
  return out
}

function packed(entry: ZipEntry): { name: Buffer; stored: Buffer; method: number; data: Buffer } {
  const name = bytes(entry.dir && typeof entry.name === "string" ? `${entry.name.replace(/\/$/, "")}/` : entry.name)
  const data = bytes(entry.data ?? "")
  const plainDirectory = entry.dir && entry.method === undefined
  const method =
    entry.method === undefined || entry.method === "deflate" ? 8 : entry.method === "stored" ? 0 : entry.method
  const stored =
    plainDirectory || entry.method === "stored" || typeof entry.method === "number" ? data : deflateRawSync(data)
  return { name, stored, method: plainDirectory ? 0 : method, data }
}

function descriptorBytes(
  descriptor: ZipDescriptor,
  values: { crc: number; size: number; compressedSize: number },
): Buffer {
  const wide = descriptor.wide ?? false
  const width = wide ? 8 : 4
  const parts: Array<[2 | 4 | 8, number]> = [
    [4, descriptor.crc ?? values.crc],
    [width, descriptor.compressedSize ?? values.compressedSize],
    [width, descriptor.size ?? values.size],
  ]
  const body = fields(...parts)
  return descriptor.signature === false ? body : Buffer.concat([fields([4, 0x08074b50]), body])
}

/** Builds a zip in memory, with the means to write it wrong: one entry per record, local headers first, then the directory. */
export function buildZip(entries: ZipEntry[], options: ZipOptions = {}): Buffer {
  const chunks: Buffer[] = []
  const records: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const { name, stored, method, data } = packed(entry)
    const utf8 = entry.utf8 ?? name.some((byte) => byte > 0x7f)
    const flags = (entry.flags ?? 0) | (utf8 ? 0x0800 : 0) | (entry.descriptor ? 0x0008 : 0)
    const crc = entry.crc ?? crc32(data)
    const size = entry.size ?? data.length
    const compressedSize = entry.compressedSize ?? stored.length
    const localName = bytes(entry.localName ?? name)
    const localExtra = entry.local?.extra ?? Buffer.alloc(0)
    const deferred = entry.descriptor !== undefined
    const before = entry.before ?? Buffer.alloc(0)
    const descriptor = entry.descriptor
      ? descriptorBytes(entry.descriptor, { crc, size, compressedSize })
      : Buffer.alloc(0)
    const local = Buffer.concat([
      before,
      fields(
        [4, 0x04034b50],
        [2, 20],
        [2, entry.local?.flags ?? flags],
        [2, method],
        [2, 0],
        [2, DOS_DATE],
        [4, entry.local?.crc ?? (deferred ? 0 : crc)],
        [4, entry.local?.compressedSize ?? (deferred ? 0 : compressedSize)],
        [4, entry.local?.size ?? (deferred ? 0 : size)],
        [2, localName.length],
        [2, localExtra.length],
      ),
      localName,
      localExtra,
      stored,
      descriptor,
    ])

    offset += before.length
    const localOffset = entry.localOffset ?? offset
    const attributes = entry.attributes ?? ((entry.dir ? DIRECTORY_MODE : REGULAR_FILE_MODE) << 16) >>> 0
    const zip64Extra = entry.zip64
      ? Buffer.concat([fields([2, 1], [2, 24]), fields([8, size], [8, compressedSize], [8, localOffset])])
      : Buffer.alloc(0)
    const extra = Buffer.concat([zip64Extra, entry.extra ?? Buffer.alloc(0)])
    records.push(
      Buffer.concat([
        fields(
          [4, 0x02014b50],
          [2, UNIX_VERSION],
          [2, 20],
          [2, flags],
          [2, method],
          [2, 0],
          [2, DOS_DATE],
          [4, crc],
          [4, entry.zip64 ? SATURATED_32 : compressedSize],
          [4, entry.zip64 ? SATURATED_32 : size],
          [2, name.length],
          [2, extra.length],
          [2, 0],
          [2, 0],
          [2, 0],
          [4, attributes],
          [4, entry.zip64 ? SATURATED_32 : localOffset],
        ),
        name,
        extra,
      ]),
    )
    chunks.push(local)
    offset += local.length - before.length
  }

  const gap = options.beforeDirectory ?? Buffer.alloc(0)
  chunks.push(gap)
  offset += gap.length
  const directory = Buffer.concat(records)
  const comment = bytes(options.comment ?? "")
  const end: Buffer[] = [directory]
  if (options.zip64) {
    const recordOffset = offset + directory.length
    end.push(
      fields(
        [4, 0x06064b50],
        [8, 44],
        [2, 45],
        [2, 45],
        [4, 0],
        [4, 0],
        [8, entries.length],
        [8, entries.length],
        [8, directory.length],
        [8, offset],
      ),
      fields([4, 0x07064b50], [4, 0], [8, recordOffset], [4, 1]),
    )
  }
  const real = options.classic === "real"
  const given = typeof options.classic === "object" ? options.classic : {}
  const classicEntries = given.entries ?? (options.zip64 && !real ? SATURATED_16 : entries.length)
  const classicSize = given.size ?? (options.zip64 && !real ? SATURATED_32 : directory.length)
  const classicOffset = given.offset ?? (options.zip64 && !real ? SATURATED_32 : offset)
  end.push(
    fields(
      [4, 0x06054b50],
      [2, 0],
      [2, 0],
      [2, classicEntries],
      [2, classicEntries],
      [4, classicSize],
      [4, classicOffset],
      [2, comment.length],
    ),
    comment,
  )
  return Buffer.concat([...chunks, ...end])
}

/** A zip64 extra field as a local header carries it: both sizes. */
export function zip64LocalExtra(size: number, compressedSize: number): Buffer {
  return Buffer.concat([fields([2, 1], [2, 16]), fields([8, size], [8, compressedSize])])
}
