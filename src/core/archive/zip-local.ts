import type { FileHandle } from "node:fs/promises"
import { ArchiveRefused, damaged } from "./refused"
import { readAt } from "./streams"
import type { CentralRecord } from "./zip-directory"

const LOCAL_SIGNATURE = 0x04034b50
const LOCAL_SIZE = 30
const DESCRIPTOR_SIGNATURE = 0x08074b50

const FLAG_ENCRYPTED = 0x0001
const FLAG_DESCRIPTOR = 0x0008
const FLAG_STRONG_ENCRYPTION = 0x0040
const FLAG_MASKED_HEADERS = 0x2000

/** The general-purpose flags that mean the data is encrypted. */
export const ENCRYPTION_FLAGS = FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADERS

/**
 * The general-purpose flags that must be the same in the local header and the
 * central record: all but bits 1 and 2, which only hint at how hard deflate
 * worked and change nothing about reading the data. Encryption (0, 6, 13),
 * the data descriptor (3) and the UTF-8 name (11) must agree, or one reader
 * would see another entry than the next.
 */
const COMPARED_FLAGS = 0xffff & ~0x0006

const SATURATED_32 = 0xffffffff
const ZIP64_EXTRA = 0x0001
const UNICODE_PATH_EXTRA = 0x7075
const UNICODE_COMMENT_EXTRA = 0x6375
const ZIP64_LOCAL_EXTRA_SIZE = 16

/** The longest data descriptor: signature, checksum and two 64-bit sizes. */
const MAX_DESCRIPTOR = 24

/** Where an entry's bytes lie: its data, and the whole of it from the local header to the end of any data descriptor. */
export type LocalLayout = { dataStart: number; end: number }

type Zip64Sizes = { size: number; compressedSize: number }

function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged("a size or offset is beyond reach")
  return Number(value)
}

/** Reads a local header's extra fields: the 64-bit sizes if there are any, and a refusal for a second name or comment. */
function readLocalExtra(extra: Buffer, shown: string): Zip64Sizes | undefined {
  let sizes: Zip64Sizes | undefined
  const seen = new Set<number>()
  for (let position = 0; position < extra.length;) {
    if (position + 4 > extra.length) throw damaged("an extra field is cut short")
    const id = extra.readUInt16LE(position)
    const length = extra.readUInt16LE(position + 2)
    const start = position + 4
    if (start + length > extra.length) throw damaged("an extra field is cut short")
    if (seen.has(id)) throw damaged("an extra field appears twice")
    seen.add(id)
    if (id === UNICODE_PATH_EXTRA) throw new ArchiveRefused("named twice, by a second name field", shown)
    if (id === UNICODE_COMMENT_EXTRA) throw new ArchiveRefused("carrying a second comment field", shown)
    if (id === ZIP64_EXTRA) {
      if (length < ZIP64_LOCAL_EXTRA_SIZE) throw damaged("a zip64 extra field is cut short")
      sizes = {
        size: toNumber(extra.readBigUInt64LE(start)),
        compressedSize: toNumber(extra.readBigUInt64LE(start + 8)),
      }
    }
    position = start + length
  }
  return sizes
}

/** Whether a local value is the central one; an entry with a data descriptor may leave the local value as zero. */
function agrees(local: number, central: number, descriptor: boolean): boolean {
  return local === central || (descriptor && local === 0)
}

/**
 * The length of the data descriptor at the start of `bytes` that repeats the
 * record's values, with or without its signature. Its width is not guessed
 * from what matches: a zip64 entry has 64-bit sizes in it and any other has
 * 32-bit ones (`wide`, from `readLocal`). Where it ends is for the coverage
 * check to hold to the next local header or the central directory.
 */
function descriptorLength(bytes: Buffer, record: CentralRecord, wide: boolean): number | undefined {
  const width = wide ? 8 : 4
  const read = (position: number) => (wide ? bytes.readBigUInt64LE(position) : BigInt(bytes.readUInt32LE(position)))
  for (const signed of [true, false]) {
    const length = (signed ? 4 : 0) + 4 + 2 * width
    if (bytes.length < length) continue
    if (signed && bytes.readUInt32LE(0) !== DESCRIPTOR_SIGNATURE) continue
    const at = signed ? 4 : 0
    if (bytes.readUInt32LE(at) !== record.crc) continue
    if (read(at + 4) === BigInt(record.compressedSize) && read(at + 4 + width) === BigInt(record.size)) return length
  }
  return undefined
}

/**
 * Reads an entry's local header and finds where its bytes lie. The header must
 * say what the central directory says, so that a program reading either one
 * sees the same entry: the method, the name, and, unless the entry has a data
 * descriptor, the checksum and both sizes (a descriptor entry may leave them
 * zero in the header, and then the descriptor after the data must repeat the
 * central values). A zip64 extra field must agree too, and a second name or
 * comment field is refused. The descriptor is 64-bit when either header marks
 * the entry as zip64, by a zip64 extra field or a saturated size.
 */
export async function readLocal(
  file: FileHandle,
  record: CentralRecord,
  directoryOffset: number,
): Promise<LocalLayout> {
  const { shown } = record
  const disagree = () => damaged(`the headers of ${shown} disagree`)
  const header = await readAt(file, record.localOffset, LOCAL_SIZE)
  if (header.length !== LOCAL_SIZE || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw damaged(`the header of ${shown} is missing`)
  }
  const flags = header.readUInt16LE(6)
  if ((flags & ENCRYPTION_FLAGS) !== 0) throw new ArchiveRefused("encrypted", shown)
  if (header.readUInt16LE(8) !== record.method) throw disagree()
  if ((flags & COMPARED_FLAGS) !== (record.flags & COMPARED_FLAGS)) throw disagree()
  const descriptor = (flags & FLAG_DESCRIPTOR) !== 0

  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  const variable = await readAt(file, record.localOffset + LOCAL_SIZE, nameLength + extraLength)
  if (variable.length !== nameLength + extraLength) throw damaged(`the header of ${shown} is missing`)
  if (!variable.subarray(0, nameLength).equals(record.rawName)) throw disagree()
  const zip64 = readLocalExtra(variable.subarray(nameLength), shown)

  if (!agrees(header.readUInt32LE(14), record.crc, descriptor)) throw disagree()
  if (zip64 !== undefined) {
    if (
      !agrees(zip64.size, record.size, descriptor) ||
      !agrees(zip64.compressedSize, record.compressedSize, descriptor)
    ) {
      throw disagree()
    }
  }
  const sizes: Array<[local: number, central: number]> = [
    [header.readUInt32LE(18), record.compressedSize],
    [header.readUInt32LE(22), record.size],
  ]
  for (const [local, central] of sizes) {
    // A saturated field says "see the zip64 field", which was just checked
    const deferred = local === SATURATED_32 && zip64 !== undefined
    if (!deferred && !agrees(local, central, descriptor)) throw disagree()
  }

  const dataStart = record.localOffset + LOCAL_SIZE + nameLength + extraLength
  const dataEnd = dataStart + record.compressedSize
  if (dataEnd > directoryOffset) throw damaged(`the data of ${shown} reaches the central directory`)
  if (!descriptor) return { dataStart, end: dataEnd }

  const after = await readAt(file, dataEnd, Math.min(MAX_DESCRIPTOR, directoryOffset - dataEnd))
  // Either header may mark the entry as zip64: a streaming writer that cannot seek saturates the local sizes and
  // adds a zip64 extra field there, and leaves the central record with ordinary sizes
  const localZip64 =
    zip64 !== undefined || header.readUInt32LE(18) === SATURATED_32 || header.readUInt32LE(22) === SATURATED_32
  const length = descriptorLength(after, record, record.zip64 || localZip64)
  if (length === undefined) throw damaged(`the data descriptor of ${shown} is missing or disagrees`)
  return { dataStart, end: dataEnd + length }
}
