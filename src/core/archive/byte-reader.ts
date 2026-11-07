import type { ArchiveRefused } from "./refused"

const NOTHING = new Uint8Array(0)

/**
 * Reads a stream of chunks as exact byte counts, which is how a tar is laid
 * out: headers of 512 bytes, then data of the size a header says, then
 * padding. `ended` makes the refusal for a stream that stops before the count
 * asked for. `signal` is checked before each chunk is taken from the stream.
 */
export class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>
  readonly #ended: () => ArchiveRefused
  readonly #signal: AbortSignal | undefined
  #chunk: Uint8Array = NOTHING
  #offset = 0

  constructor(source: AsyncIterable<Uint8Array>, ended: () => ArchiveRefused, signal?: AbortSignal) {
    this.#iterator = source[Symbol.asyncIterator]()
    this.#ended = ended
    this.#signal = signal
  }

  /** Makes some unread bytes available; `false` at the end of the stream. */
  async #fill(): Promise<boolean> {
    while (this.#offset >= this.#chunk.length) {
      this.#signal?.throwIfAborted()
      const next = await this.#iterator.next()
      if (next.done) return false
      this.#chunk = next.value
      this.#offset = 0
    }
    return true
  }

  /** Reads `size` bytes, or fewer where the stream ends. */
  async read(size: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = []
    let have = 0
    while (have < size && (await this.#fill())) {
      const part = this.#chunk.subarray(this.#offset, this.#offset + size - have)
      this.#offset += part.length
      have += part.length
      parts.push(part)
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
  }

  /** Yields exactly `size` bytes in chunks; the stream ending first is the `ended` refusal. */
  async *take(size: number): AsyncGenerator<Uint8Array> {
    for (let left = size; left > 0;) {
      if (!(await this.#fill())) throw this.#ended()
      const part = this.#chunk.subarray(this.#offset, this.#offset + left)
      this.#offset += part.length
      left -= part.length
      yield part
    }
  }

  /** Yields everything left, to the end of the stream. */
  async *rest(): AsyncGenerator<Uint8Array> {
    while (await this.#fill()) {
      const part = this.#chunk.subarray(this.#offset)
      this.#offset = this.#chunk.length
      yield part
    }
  }

  /** Skips exactly `size` bytes. */
  async skip(size: number): Promise<void> {
    for await (const _ of this.take(size));
  }

  /** Stops reading and releases the stream. */
  async close(): Promise<void> {
    await this.#iterator.return?.()
  }
}
