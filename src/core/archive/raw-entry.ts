/** An entry of an archive: its name as the archive wrote it, whether it is a directory, and the size its header declares. */
export type ArchiveEntry = { name: string; dir: boolean; size: number }

/**
 * An entry with its data, which a reader hands to `walkArchive` before it
 * reads the next one. `data` is `null` for a directory; otherwise it yields
 * the file's bytes and, once drained, has checked them against the header.
 */
export type RawEntry = { entry: ArchiveEntry; data: AsyncGenerator<Uint8Array> | null }
