/** One entry for `buildTar`. */
export type TarEntry = {
  name: string | Buffer
  data?: Buffer | string
  /** The type flag character; default `0`. */
  type?: string
  linkname?: string
  /** The size field, when it should not be the data's length: a number is written in octal. */
  size?: number | Buffer
  /** The ustar prefix field, joined to the name with a `/`. */
  prefix?: string
  /** `ustar` (default), `gnu` or `v7` (no magic). */
  magic?: "ustar" | "gnu" | "v7"
  /** Writes a checksum that is wrong. */
  badChecksum?: boolean
}

/** The size of one tar block in bytes. */
export const TAR_BLOCK = 512

/** The two zero blocks that end a tar. */
export const TAR_END = Buffer.alloc(2 * TAR_BLOCK)

function bytes(text: string | Buffer): Buffer {
  return typeof text === "string" ? Buffer.from(text) : text
}

function padded(data: Buffer): Buffer {
  return Buffer.concat([data, Buffer.alloc((TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK)])
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`)
}

/** A base-256 size field of 12 bytes. */
export function base256(value: number): Buffer {
  const field = Buffer.alloc(12)
  field.writeBigUInt64BE(BigInt(value), 4)
  field[0] = 0x80
  return field
}

/** One header block. */
export function tarHeader(entry: TarEntry): Buffer {
  const data = bytes(entry.data ?? "")
  const block = Buffer.alloc(TAR_BLOCK)
  bytes(entry.name).copy(block, 0, 0, 100)
  octal(0o644, 8).copy(block, 100)
  octal(0, 8).copy(block, 108)
  octal(0, 8).copy(block, 116)
  const size = entry.size ?? data.length
  ;(typeof size === "number" ? octal(size, 12) : size).copy(block, 124)
  octal(0, 12).copy(block, 136)
  block.fill(0x20, 148, 156)
  block.write(entry.type ?? "0", 156, "latin1")
  block.write(entry.linkname ?? "", 157, "latin1")
  const magic = entry.magic ?? "ustar"
  if (magic === "ustar") block.write("ustar\x0000", 257, "latin1")
  if (magic === "gnu") block.write("ustar  \0", 257, "latin1")
  if (entry.prefix !== undefined) block.write(entry.prefix, 345, "latin1")
  const sum = block.reduce((total, byte) => total + byte, 0)
  octal(entry.badChecksum ? sum + 1 : sum, 7).copy(block, 148)
  block[155] = 0x20
  return block
}

/** An entry as header and padded data. */
export function tarEntry(entry: TarEntry): Buffer {
  return Buffer.concat([tarHeader(entry), padded(bytes(entry.data ?? ""))])
}

/** The data of a pax extended header: `<length> <key>=<value>\n` records. */
export function paxData(records: Record<string, string>): Buffer {
  return Buffer.concat(
    Object.entries(records).map(([key, value]) => {
      const body = `${key}=${value}\n`
      const recordLength = (length: number) => Buffer.byteLength(`${length} ${body}`)
      let length = Buffer.byteLength(body) + 1
      while (recordLength(length) !== length) length = recordLength(length)
      return Buffer.from(`${length} ${body}`)
    }),
  )
}

/** A pax extended header that applies to the entry after it (`x`) or to all (`g`). */
export function paxEntry(records: Record<string, string>, type: "x" | "g" = "x"): Buffer {
  return tarEntry({ name: "PaxHeader", type, data: paxData(records) })
}

/** A GNU long name entry for the entry after it. */
export function longNameEntry(name: string): Buffer {
  return tarEntry({ name: "././@LongLink", type: "L", data: Buffer.from(`${name}\0`), magic: "gnu" })
}

/** Builds a tar from entries and ready-made blocks, ended with two zero blocks unless `end` is `false`. */
export function buildTar(parts: Array<TarEntry | Buffer>, end = true): Buffer {
  const blocks = parts.map((part) => (Buffer.isBuffer(part) ? part : tarEntry(part)))
  return Buffer.concat(end ? [...blocks, TAR_END] : blocks)
}
