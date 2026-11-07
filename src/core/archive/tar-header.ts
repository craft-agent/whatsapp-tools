/** The size of a tar block, which headers and the padding of data are measured in. */
export const TAR_BLOCK_SIZE = 512

const CHECKSUM_START = 148
const CHECKSUM_END = 156
const SIZE_START = 124
const SIZE_END = 136
const NAME_END = 100
const TYPE_OFFSET = 156
const MAGIC_START = 257
const PREFIX_START = 345
const PREFIX_END = 500

const SPACE = 0x20
const OCTAL_ZERO = 0x30
const OCTAL_SEVEN = 0x37
const BASE256_FLAG = 0x80
const BASE256_NEGATIVE = 0xff
const BYTE_VALUES = 256
const PAX_LENGTH_DIGITS = 10
const EQUALS = 0x3d
const NEWLINE = 0x0a

const POSIX_MAGIC = [0x75, 0x73, 0x74, 0x61, 0x72, 0x00]

/** What one header block says, before extended headers change it. */
export type TarHeader = {
  /** The path as bytes: the prefix, a `/` and the name when the header is POSIX ustar with a prefix. */
  path: Uint8Array
  /** The size of the data that follows, or `undefined` when the field is not a number. */
  size: number | undefined
  /** The type flag byte: `0x30` (`0`) for a regular file, `0x35` (`5`) for a directory. */
  type: number
}

/** One record of a pax extended header. */
export type PaxRecord = { key: string; value: Uint8Array }

/** Whether the block is all zeros, as the two blocks that end an archive are. */
export function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0)
}

/** Cuts a byte slice at its first NUL byte, or returns it whole when there is none. */
export function trimNul(field: Uint8Array): Uint8Array {
  const end = field.indexOf(0)
  return end === -1 ? field : field.subarray(0, end)
}

/** An octal number padded with spaces or NULs, or `undefined` when it holds anything else or no digit. */
function parseOctal(field: Uint8Array): number | undefined {
  let value = 0
  let digits = 0
  let ended = false
  for (const byte of field) {
    if (byte === 0 || byte === SPACE) {
      if (digits > 0) ended = true
      continue
    }
    if (ended || byte < OCTAL_ZERO || byte > OCTAL_SEVEN) return undefined
    value = value * 8 + (byte - OCTAL_ZERO)
    digits++
  }
  return digits > 0 ? value : undefined
}

/** A number as a header writes it: octal, or base-256 when the high bit of the first byte is set. */
function parseNumber(field: Uint8Array): number | undefined {
  const first = field[0]
  if (first === undefined || (first & BASE256_FLAG) === 0) return parseOctal(field)
  if (first === BASE256_NEGATIVE) return undefined
  let value = first & ~BASE256_FLAG
  for (let i = 1; i < field.length; i++) {
    value = value * BYTE_VALUES + field[i]!
    if (value > Number.MAX_SAFE_INTEGER) return undefined
  }
  return value
}

/** Whether the stored checksum equals the sum of the block's bytes, the checksum field counted as spaces. */
export function checksumMatches(block: Uint8Array): boolean {
  const stored = parseOctal(block.subarray(CHECKSUM_START, CHECKSUM_END))
  if (stored === undefined) return false
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    const byte = i >= CHECKSUM_START && i < CHECKSUM_END ? SPACE : block[i]!
    unsigned += byte
    signed += byte > 0x7f ? byte - BYTE_VALUES : byte
  }
  return stored === unsigned || stored === signed
}

/** Whether the bytes start with a tar header: a whole block that is not empty and whose checksum is right. */
export function looksLikeTarHeader(head: Uint8Array): boolean {
  const block = head.subarray(0, TAR_BLOCK_SIZE)
  return block.length === TAR_BLOCK_SIZE && !isZeroBlock(block) && checksumMatches(block)
}

/** Reads a header block that has passed `checksumMatches`. */
export function parseHeader(block: Uint8Array): TarHeader {
  const name = trimNul(block.subarray(0, NAME_END))
  const isPosix = POSIX_MAGIC.every((byte, i) => block[MAGIC_START + i] === byte)
  const prefix = isPosix ? trimNul(block.subarray(PREFIX_START, PREFIX_END)) : new Uint8Array()
  const path = new Uint8Array(prefix.length === 0 ? name.length : prefix.length + 1 + name.length)
  if (prefix.length === 0) {
    path.set(name)
  } else {
    path.set(prefix)
    path[prefix.length] = "/".charCodeAt(0)
    path.set(name, prefix.length + 1)
  }
  return { path, size: parseNumber(block.subarray(SIZE_START, SIZE_END)), type: block[TYPE_OFFSET]! }
}

/** The number a pax `size` record holds, or `undefined` when it is not a plain decimal. */
export function parseDecimal(text: string): number | undefined {
  if (!/^[0-9]{1,15}$/.test(text)) return undefined
  return Number(text)
}

/**
 * Reads the records of a pax extended header (`<length> <key>=<value>\n`), or
 * `undefined` when it is malformed or holds more than `maxRecords`.
 */
export function parsePaxRecords(data: Uint8Array, maxRecords = Infinity): PaxRecord[] | undefined {
  const records: PaxRecord[] = []
  const keyDecoder = new TextDecoder()
  let position = 0
  while (position < data.length) {
    if (records.length >= maxRecords) return undefined
    const space = data.indexOf(SPACE, position)
    if (space === -1 || space - position > PAX_LENGTH_DIGITS) return undefined
    const length = parseDecimal(keyDecoder.decode(data.subarray(position, space)))
    if (length === undefined || length <= space - position + 1 || position + length > data.length) return undefined
    const body = data.subarray(space + 1, position + length)
    if (body[body.length - 1] !== NEWLINE) return undefined
    const equals = body.indexOf(EQUALS)
    if (equals <= 0) return undefined
    records.push({
      key: keyDecoder.decode(body.subarray(0, equals)),
      value: body.subarray(equals + 1, body.length - 1),
    })
    position += length
  }
  return records
}
