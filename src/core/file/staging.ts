import { join } from "node:path"
import { createNew, ensureDirectory, writeAll } from "./fs-safe"

/**
 * A folder an archive is unpacked into, written only the way unpacking may:
 * every folder is made one component at a time (0700) and checked with
 * `lstat`, so a link planted in the way is refused rather than followed, and
 * every file is created new (0600, never executable) with a link at its name
 * refused too.
 */
export class Staging {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  /** Makes the folder named by `parts` below the root, and each folder on the way. */
  async directory(parts: readonly string[]): Promise<void> {
    let current = this.#root
    for (const part of parts) {
      current = join(current, part)
      await ensureDirectory(current)
    }
  }

  /**
   * Writes a new file at `parts` below the root from `data`; the name must be
   * free, and so must not be a link either. `signal` is checked before each
   * chunk is written.
   */
  async file(parts: readonly string[], data: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> {
    await this.directory(parts.slice(0, -1))
    const target = await createNew(join(this.#root, ...parts))
    try {
      for await (const chunk of data) {
        signal?.throwIfAborted()
        await writeAll(target, chunk)
      }
    } finally {
      await target.close()
    }
  }
}
