import type { FileHandle } from "node:fs/promises"
import { inspectArchive, type ArchiveListing } from "../archive/inspect"
import { classifyFile, type ArchiveFormat } from "../archive/kind"
import type { ArchiveLimits } from "../archive/limits"
import { ArchiveRefused } from "../archive/refused"
import { copyToPartial, discard, placeFile, type Placed } from "./place"

/** What became of the file. */
export type SaveOutcome =
  | { kind: "refused"; reason: string }
  | {
      kind: "saved"
      placed: Placed
      size: number
      sha256: string
      /** Set when the file is an archive that passed inspection. */
      archive?: { format: ArchiveFormat; listing: ArchiveListing }
    }

/** What is known of a file before its bytes are read: the name it is saved under and the type its sender gave it. */
export type FileClaim = { name: string; type?: string }

/** How the reason of a file whose name or type claims a format its bytes are not begins; with no bytes, every archive or document name would say it. */
const MISLABELED = "mislabeled"

/**
 * Why the name and declared type alone already refuse a file (a program, an installer, a format that cannot be
 * inspected), so that none of it need be fetched; `undefined` when they do not decide. A claim only the bytes can
 * check, an archive or a document, does not count: the bytes are judged again after the file is fetched.
 */
export function refusedByClaim({ name, type }: FileClaim): string | undefined {
  const kind = classifyFile({ name, type, head: new Uint8Array() })
  return kind.kind === "refused" && !kind.reason.startsWith(MISLABELED) ? kind.reason : undefined
}

/**
 * Saves a file into a message's folder: copies it out of the open `source`
 * (which it closes) into a private partial while taking its SHA-256, judges
 * the copy by its name, declared type and first bytes (a program or an
 * installer is removed again), inspects it when it is an archive (a refused
 * one is removed again), and only then places it under its name without
 * overwriting anything. The partial is gone whatever happens.
 */
export async function saveFile(
  source: FileHandle,
  { name, type }: FileClaim,
  folder: string,
  signal?: AbortSignal,
  limits?: ArchiveLimits,
): Promise<SaveOutcome> {
  const copied = await copyToPartial(source, folder, signal).finally(() => source.close())
  try {
    const kind = classifyFile({ name, type, head: copied.head })
    if (kind.kind === "refused") {
      await discard(copied.partial)
      return { kind: "refused", reason: kind.reason }
    }
    let archive: Extract<SaveOutcome, { kind: "saved" }>["archive"]
    if (kind.kind === "archive") {
      try {
        archive = { format: kind.format, listing: await inspectArchive(copied.partial, kind.format, limits, signal) }
      } catch (error) {
        if (!(error instanceof ArchiveRefused)) throw error
        await discard(copied.partial)
        return { kind: "refused", reason: error.message }
      }
    }
    const placed = await placeFile(copied, folder, name)
    return { kind: "saved", placed, size: copied.size, sha256: copied.sha256, ...(archive && { archive }) }
  } catch (error) {
    await discard(copied.partial)
    throw error
  }
}
