import type { FileHandle } from "node:fs/promises"
import { cleanName } from "./clean-name"
import { decodeCp437, decodeUtf8, decodeUtf8Lossy } from "./encoding"
import type { ArchiveLimits } from "./limits"
import { ArchiveRefused, damaged } from "./refused"
import { readAt } from "./streams"

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
const LOCATOR_SIGNATURE = 0x07064b50
const LOCATOR_SIZE = 20
const EOCD64_SIGNATURE = 0x06064b50
const EOCD64_SIZE = 56
const CENTRAL_SIGNATURE = 0x02014b50
const CENTRAL_SIZE = 46

/** The most a central directory may take, which at 500 entries is room for names and extra fields far past anything real. */
const MAX_CENTRAL_DIRECTORY = 4 * 1024 * 1024

const SATURATED_16 = 0xffff
const SATURATED_32 = 0xffffffff
const ZIP64_EXTRA = 0x0001
const UNICODE_PATH_EXTRA = 0x7075
const FLAG_UTF8 = 0x0800

/** One entry of the central directory, read and not yet checked against its local header. */
export type CentralRecord = {
  rawName: Buffer
  name: string
  shown: string
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
  externalAttributes: number
  hasUnicodePath: boolean
  /** Whether the record carries a zip64 extra field or any saturated 32-bit field: the entry is a zip64 one. */
  zip64: boolean
}

/** The central directory's location and entry count in the archive. */
export type ZipDirectory = { offset: number; size: number; count: number; end: number }

function notZip(): ArchiveRefused {
  return damaged("it is not a zip, or its end is missing")
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged("a size or offset is beyond reach")
  return Number(value)
}

/**
 * Whether the end record at `found` is not the only one a reader could take:
 * its comment holds the signature of another, or an earlier record's comment
 * runs to the end of the file, which would make it a real one with this one
 * hidden in its comment.
 */
function hasSecondEndRecord(tail: Buffer, found: number): boolean {
  if (tail.subarray(found + EOCD_SIZE).includes(EOCD_SIGNATURE)) return true
  for (let earlier = found > 0 ? tail.lastIndexOf(EOCD_SIGNATURE, found - 1) : -1; earlier !== -1;) {
    if (earlier + EOCD_SIZE <= tail.length && earlier + EOCD_SIZE + tail.readUInt16LE(earlier + 20) === tail.length) {
      return true
    }
    earlier = earlier > 0 ? tail.lastIndexOf(EOCD_SIGNATURE, earlier - 1) : -1
  }
  return false
}

/** Finds the end-of-central-directory record, which must be the last thing in the file, and reads the directory's place from it. */
export async function readDirectory(file: FileHandle, fileSize: number, limits: ArchiveLimits): Promise<ZipDirectory> {
  if (fileSize < EOCD_SIZE) throw notZip()
  const tailSize = Math.min(fileSize, EOCD_SIZE + MAX_COMMENT)
  const tailStart = fileSize - tailSize
  const tail = await readAt(file, tailStart, tailSize)
  // The nearest candidate to the end is the one most unzip programs take, so a second record hidden earlier is never read instead of it
  const found = tail.lastIndexOf(EOCD_SIGNATURE, tail.length - EOCD_SIZE)
  if (found === -1 || found + EOCD_SIZE + tail.readUInt16LE(found + 20) !== tail.length) throw notZip()
  if (hasSecondEndRecord(tail, found)) throw damaged("its end record is ambiguous: another one is hidden in it")

  const position = tailStart + found
  const disk = tail.readUInt16LE(found + 4)
  const directoryDisk = tail.readUInt16LE(found + 6)
  const onDisk = tail.readUInt16LE(found + 8)
  let count = tail.readUInt16LE(found + 10)
  let size = tail.readUInt32LE(found + 12)
  let offset = tail.readUInt32LE(found + 16)
  let end = position
  let multiDisk = disk !== 0 || directoryDisk !== 0 || onDisk !== count

  const locator = position >= LOCATOR_SIZE ? await readAt(file, position - LOCATOR_SIZE, LOCATOR_SIZE) : undefined
  if (locator && locator.length === LOCATOR_SIZE && locator.readUInt32LE(0) === LOCATOR_SIGNATURE) {
    const recordOffset = safeNumber(locator.readBigUInt64LE(8))
    const locatorPosition = position - LOCATOR_SIZE
    multiDisk = locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1
    if (recordOffset + EOCD64_SIZE > locatorPosition) throw notZip()
    const record = await readAt(file, recordOffset, EOCD64_SIZE)
    if (record.length !== EOCD64_SIZE || record.readUInt32LE(0) !== EOCD64_SIGNATURE) throw notZip()
    const recordSize = safeNumber(record.readBigUInt64LE(4))
    if (recordOffset + 12 + recordSize > locatorPosition) throw notZip()
    const wideOnDisk = record.readBigUInt64LE(24)
    const wideCount = record.readBigUInt64LE(32)
    const wideSize = record.readBigUInt64LE(40)
    const wideOffset = record.readBigUInt64LE(48)
    // Each classic field either defers to the zip64 record (saturated) or says the same; a record that disagrees with the classic one is read differently by different programs
    const same = (classic: number, saturated: number, wide: bigint) => classic === saturated || BigInt(classic) === wide
    if (
      !same(onDisk, SATURATED_16, wideOnDisk) ||
      !same(count, SATURATED_16, wideCount) ||
      !same(size, SATURATED_32, wideSize) ||
      !same(offset, SATURATED_32, wideOffset)
    ) {
      throw damaged("its zip64 end record disagrees with the classic one")
    }
    multiDisk ||= [disk, directoryDisk].some((value) => value !== 0 && value !== SATURATED_16)
    multiDisk ||= record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0 || wideOnDisk !== wideCount
    count = safeNumber(wideCount)
    size = safeNumber(wideSize)
    offset = safeNumber(wideOffset)
    end = recordOffset
  } else if (count === SATURATED_16 || size === SATURATED_32 || offset === SATURATED_32) {
    throw notZip()
  }

  if (multiDisk) throw new ArchiveRefused("the archive is split over several files")
  if (count > limits.maxEntries) {
    throw new ArchiveRefused(`the archive has more than ${limits.maxEntries} entries`)
  }
  // Exactly up to the record that follows it: a gap would let programs that count back from the end disagree on every offset
  if (size > MAX_CENTRAL_DIRECTORY || size < count * CENTRAL_SIZE || offset + size !== end) throw notZip()
  return { offset, size, count, end }
}

/** Which of the sizes and the offset the 32-bit fields could not hold, and so the zip64 extra field carries. */
type Wanted = { size: boolean; compressedSize: boolean; localOffset: boolean }

/** What the extra fields add: the 64-bit values asked for, and whether a second name is carried. */
type ExtraFields = {
  size?: number
  compressedSize?: number
  localOffset?: number
  hasUnicodePath: boolean
  hasZip64: boolean
}

/** Reads the extra fields that matter. An id that appears twice is refused: programs would not agree on which counts. */
function readExtra(extra: Buffer, wanted: Wanted): ExtraFields {
  const result: ExtraFields = { hasUnicodePath: false, hasZip64: false }
  const seen = new Set<number>()
  for (let position = 0; position < extra.length;) {
    if (position + 4 > extra.length) throw damaged("an extra field is cut short")
    const id = extra.readUInt16LE(position)
    const length = extra.readUInt16LE(position + 2)
    const start = position + 4
    if (start + length > extra.length) throw damaged("an extra field is cut short")
    if (seen.has(id)) throw damaged("an extra field appears twice")
    seen.add(id)
    if (id === UNICODE_PATH_EXTRA) result.hasUnicodePath = true
    if (id === ZIP64_EXTRA) {
      result.hasZip64 = true
      let at = start
      const take = (): number => {
        if (at + 8 > start + length) throw damaged("a zip64 extra field is cut short")
        const value = safeNumber(extra.readBigUInt64LE(at))
        at += 8
        return value
      }
      if (wanted.size) result.size = take()
      if (wanted.compressedSize) result.compressedSize = take()
      if (wanted.localOffset) result.localOffset = take()
    }
    position = start + length
  }
  return result
}

/** A name as text: UTF-8 when the entry says so (and must be valid) or when it is valid anyway, else code page 437. */
function decodeName(rawName: Buffer, flags: number): { name: string; invalid: boolean } {
  const utf8 = decodeUtf8(rawName)
  if (utf8 !== undefined) return { name: utf8, invalid: false }
  if ((flags & FLAG_UTF8) !== 0) return { name: decodeUtf8Lossy(rawName), invalid: true }
  return { name: decodeCp437(rawName), invalid: false }
}

/** Reads the central directory records. */
export function readCentralRecords(directory: Buffer, count: number): CentralRecord[] {
  const records: CentralRecord[] = []
  let position = 0
  for (let index = 0; index < count; index++) {
    if (position + CENTRAL_SIZE > directory.length || directory.readUInt32LE(position) !== CENTRAL_SIGNATURE) {
      throw damaged("the central directory is cut short or out of order")
    }
    const flags = directory.readUInt16LE(position + 8)
    const nameLength = directory.readUInt16LE(position + 28)
    const extraLength = directory.readUInt16LE(position + 30)
    const commentLength = directory.readUInt16LE(position + 32)
    const nameStart = position + CENTRAL_SIZE
    const extraStart = nameStart + nameLength
    const next = extraStart + extraLength + commentLength
    if (next > directory.length) throw damaged("the central directory is cut short or out of order")

    const rawName = directory.subarray(nameStart, extraStart)
    const { name, invalid } = decodeName(rawName, flags)
    const shown = cleanName(name)
    if (invalid) throw new ArchiveRefused("named with bytes that are not valid UTF-8", shown)

    const sizes = {
      size: directory.readUInt32LE(position + 24),
      compressedSize: directory.readUInt32LE(position + 20),
      localOffset: directory.readUInt32LE(position + 42),
    }
    const extra = readExtra(directory.subarray(extraStart, extraStart + extraLength), {
      size: sizes.size === SATURATED_32,
      compressedSize: sizes.compressedSize === SATURATED_32,
      localOffset: sizes.localOffset === SATURATED_32,
    })
    records.push({
      rawName: Buffer.from(rawName),
      name,
      shown,
      flags,
      method: directory.readUInt16LE(position + 10),
      crc: directory.readUInt32LE(position + 16),
      compressedSize: extra.compressedSize ?? sizes.compressedSize,
      size: extra.size ?? sizes.size,
      localOffset: extra.localOffset ?? sizes.localOffset,
      externalAttributes: directory.readUInt32LE(position + 38),
      hasUnicodePath: extra.hasUnicodePath,
      zip64: extra.hasZip64 || Object.values(sizes).includes(SATURATED_32),
    })
    position = next
  }
  if (position !== directory.length) throw damaged("the central directory has more in it than its entries")
  return records
}
