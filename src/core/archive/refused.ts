/**
 * Why an archive cannot be accepted. With an `entry` (its cleaned name) the
 * `reason` completes "the entry … is": `a symbolic link`, `encrypted`; without
 * one it is a whole sentence about the archive. Whoever catches it maps it to
 * the error its tool throws.
 */
export class ArchiveRefused extends Error {
  readonly reason: string
  readonly entry: string | undefined

  constructor(reason: string, entry?: string) {
    super(entry === undefined ? reason : `the entry ${entry} is ${reason}`)
    this.name = "ArchiveRefused"
    this.reason = reason
    this.entry = entry
  }
}

/** The refusal for an archive that cannot be read to its end. */
export function damaged(detail: string): ArchiveRefused {
  return new ArchiveRefused(`the archive is damaged (${detail})`)
}
