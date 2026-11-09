/**
 * Why a file may not be sent. With an `entry` (the cleaned name of an entry of
 * an archive) the `reason` completes "the entry … is": `a private key`;
 * without one it completes "the file … is". Whoever catches it maps it to the
 * error its tool throws.
 */
export class OutgoingRefused extends Error {
  readonly reason: string
  readonly entry: string | undefined

  constructor(reason: string, entry?: string) {
    super(entry === undefined ? reason : `the entry ${entry} is ${reason}`)
    this.name = "OutgoingRefused"
    this.reason = reason
    this.entry = entry
  }
}
