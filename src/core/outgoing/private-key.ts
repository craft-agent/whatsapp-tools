/** The longest label a PEM block may carry between `BEGIN` and `PRIVATE KEY` (`RSA`, `ENCRYPTED`, `OPENSSH`, `PGP`, …); real ones are under 12. */
const LABEL_MAX = 40

const PEM_BEGIN = "-----BEGIN "
const PEM_END = "PRIVATE KEY BLOCK-----"
const SSH2_LONGEST = "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----"
const PUTTY_LONGEST = "PuTTY-User-Key-File-0:"

/**
 * The first lines of the private key formats, each with the most characters
 * it can take, so that a marker cut by a chunk boundary is found:
 *
 * - PEM and what is written like it (`PRIVATE KEY`, `RSA PRIVATE KEY`,
 *   `EC PRIVATE KEY`, `ENCRYPTED PRIVATE KEY`, `OPENSSH PRIVATE KEY`, and
 *   PGP's `PGP PRIVATE KEY BLOCK`), with a label of letters, digits, spaces,
 *   `_` and `-`, bounded: a longer one is no label a key parser reads;
 * - the ssh.com format, with four dashes and spaces around `BEGIN`;
 * - PuTTY's `.ppk`, which has no armor but opens with its version.
 */
const MARKERS: readonly { pattern: string; longest: number }[] = [
  {
    pattern: `${PEM_BEGIN}(?:[A-Za-z0-9 _-]{1,${LABEL_MAX}} )?PRIVATE KEY(?: BLOCK)?-----`,
    longest: PEM_BEGIN.length + LABEL_MAX + " ".length + PEM_END.length,
  },
  { pattern: "---- BEGIN SSH2 (?:ENCRYPTED )?PRIVATE KEY ----", longest: SSH2_LONGEST.length },
  { pattern: "PuTTY-User-Key-File-[0-9]:", longest: PUTTY_LONGEST.length },
]

const MARKER = new RegExp(MARKERS.map(({ pattern }) => pattern).join("|"))

/** The most of one chunk's end that a marker can reach into the next. */
const TAIL_LENGTH = Math.max(...MARKERS.map(({ longest }) => longest)) - 1

const NUL = "\0"

/** Text that a marker is looked for in, with the end of what came before so that a marker across two pieces is found. */
class Window {
  #tail: string

  constructor(tail = "") {
    this.#tail = tail
  }

  get tail(): string {
    return this.#tail
  }

  sees(text: string): boolean {
    const all = this.#tail + text
    this.#tail = all.slice(-TAIL_LENGTH)
    return MARKER.test(all)
  }
}

/**
 * Looks for a private key marker in a file's bytes, chunk by chunk, keeping
 * the end of each chunk so that a marker across a boundary is found. The bytes
 * are read as they are and, once a chunk holds a NUL, also with every NUL
 * removed: ASCII text in UTF-16 (either byte order, either alignment, with or
 * without a byte order mark, whatever else the text holds) or in UTF-32 has a
 * NUL beside each character, so the marker reads as plain text again. A file
 * with no NUL is read once; one with NULs twice, whatever its size. A UTF-16
 * byte order mark is no help the NUL-free view lacks, so none is read. Only a
 * key written out in plain text is found: one inside a compressed or encoded
 * container is not.
 */
export class PrivateKeyScan {
  readonly #plain = new Window()
  #withoutNuls: Window | undefined

  /** Feeds the next chunk; whether a marker starts anywhere in the bytes so far. */
  sees(chunk: Uint8Array): boolean {
    // latin1 maps every byte to one character, so an ASCII marker matches wherever it is
    const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1")
    const before = this.#plain.tail
    const plain = this.#plain.sees(text)
    if (this.#withoutNuls === undefined && text.includes(NUL)) {
      // Nothing before this chunk held a NUL, so its end is also what the NUL-free view saw
      this.#withoutNuls = new Window(before)
    }
    const stripped = this.#withoutNuls?.sees(text.replaceAll(NUL, "")) ?? false
    return plain || stripped
  }
}
