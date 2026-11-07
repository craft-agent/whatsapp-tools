import { ToolError } from "../errors"
import type { ChatReadInput, Method } from "./schema"

/** The arguments each method takes besides `method` and `account`; any other that is given is refused, not ignored. */
const METHOD_ARGUMENTS = {
  list: ["query", "unread", "last", "limit", "cursor"],
  view: ["chat", "after", "before", "limit", "cursor"],
} as const satisfies Record<Method, readonly (keyof ChatReadInput)[]>

const SHARED_ARGUMENTS: readonly (keyof ChatReadInput)[] = ["method", "account"]

/** Refuses, as `invalid_argument`, an argument the call's method does not take. */
export function checkArguments(args: ChatReadInput): void {
  const takes: readonly string[] = [...SHARED_ARGUMENTS, ...METHOD_ARGUMENTS[args.method]]
  const stray = Object.entries(args).find(([name, value]) => value !== undefined && !takes.includes(name))
  if (stray) {
    throw new ToolError(
      "invalid_argument",
      `${stray[0]} does not apply to the ${args.method} method; it takes ${METHOD_ARGUMENTS[args.method].join(", ")}.`,
    )
  }
}
