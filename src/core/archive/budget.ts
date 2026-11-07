import { describeSize } from "./limits"
import { ArchiveRefused } from "./refused"

/** A count of bytes an archive may still spend, spent as the bytes are read. */
export class ByteBudget {
  readonly #limit: number
  readonly #exceeded: (limit: string) => ArchiveRefused
  #remaining: number

  /** `exceeded` makes the refusal, given the limit as a size for a message. */
  constructor(limit: number, exceeded: (limit: string) => ArchiveRefused) {
    this.#limit = limit
    this.#exceeded = exceeded
    this.#remaining = limit
  }

  /** The budget for entry data. */
  static forData(limit: number): ByteBudget {
    return new ByteBudget(limit, (size) => new ArchiveRefused(`the archive unpacks to more than ${size}`))
  }

  /** The budget for what an archive holds besides entry data. */
  static forMetadata(limit: number): ByteBudget {
    return new ByteBudget(
      limit,
      (size) => new ArchiveRefused(`the archive's headers and padding take more than ${size}`),
    )
  }

  /** Refuses at once when `bytes` more could not fit, without spending them. */
  check(bytes: number): void {
    if (bytes > this.#remaining) throw this.#exceeded(describeSize(this.#limit))
  }

  /** Spends `bytes` that were just read; refuses when that goes past the limit. */
  take(bytes: number): void {
    this.#remaining -= bytes
    if (this.#remaining < 0) throw this.#exceeded(describeSize(this.#limit))
  }
}
