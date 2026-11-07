const MEGABYTE = 1024 * 1024

/** The most entries an archive may hold, directories included. */
export const MAX_ENTRIES = 500

/** The most bytes of entry data an archive may unpack to, counted from the bytes read. Headers and padding are not entry data. */
export const MAX_TOTAL_SIZE = 500 * MEGABYTE

/**
 * The most bytes a tar may spend on what is not entry data: header blocks,
 * pax and GNU extension data, padding, the end marker and the zeros after it.
 * Kept apart from `MAX_TOTAL_SIZE` so that an archive holding exactly that
 * much data passes however it is laid out, while its overhead stays bounded:
 * 500 entries need well under a megabyte, and tar pads an archive out to a
 * record size.
 */
export const MAX_METADATA_SIZE = 16 * MEGABYTE

/**
 * The largest archive file that is read at all. An archive cannot hold more
 * than its entry data and metadata, so a larger file is mostly something
 * else; refusing it first bounds the work gzip does on huge name and comment
 * fields and on many empty members, which unpack to nothing the budgets count.
 */
export const MAX_INPUT_SIZE = MAX_TOTAL_SIZE + MAX_METADATA_SIZE

/** What an archive may hold; a test injects smaller ones. */
export type ArchiveLimits = {
  maxEntries: number
  /** Bytes of entry data. */
  maxTotalSize: number
  /** Bytes of tar headers, extension data and padding. */
  maxMetadata: number
  /** Bytes of the archive file itself. */
  maxInputSize: number
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: MAX_ENTRIES,
  maxTotalSize: MAX_TOTAL_SIZE,
  maxMetadata: MAX_METADATA_SIZE,
  maxInputSize: MAX_INPUT_SIZE,
}

/** A size for a message: whole megabytes as `500 MB`, anything else in bytes. */
export function describeSize(bytes: number): string {
  return bytes % MEGABYTE === 0 ? `${bytes / MEGABYTE} MB` : `${bytes} bytes`
}
