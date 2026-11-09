import { TextDecoder } from "node:util"
import { CLASSIFY_HEAD_BYTES } from "../archive/kind"
import { PrivateKeyScan } from "./private-key"
import { isSourceName } from "./source-names"

/** The reason for a file that holds a private key (`PrivateKeyScan`). */
export const PRIVATE_KEY_REASON = "a private key"

/** The reason for a file named as source code whose bytes are not text. */
export const BINARY_SCRIPT_REASON = "a script whose bytes are not text"

/**
 * Whether the bytes are text: no NUL and valid UTF-8, a byte order mark
 * allowed. A head as long as `CLASSIFY_HEAD_BYTES` may end inside a
 * character, which is allowed; a shorter one is the whole file and may not.
 */
function isText(head: Uint8Array): boolean {
  if (head.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: head.length >= CLASSIFY_HEAD_BYTES })
    return true
  } catch {
    return false
  }
}

/** Why the first bytes of a file named `name` refuse it as a script, or `undefined`: a name that says source code needs bytes that are text. */
export function scriptProblem(name: string, head: Uint8Array): string | undefined {
  return isSourceName(name) && !isText(head) ? BINARY_SCRIPT_REASON : undefined
}

/**
 * Reads the data of one file to its end and returns why it may not be sent,
 * or `undefined`: it holds a private key block anywhere, or its name says
 * source code and its first bytes are not text (`scriptProblem`). Stops at the
 * first problem. `signal` is checked before each chunk and stops the reading
 * with its `AbortError`.
 */
export async function scanData(
  name: string,
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const keys = new PrivateKeyScan()
  let head: Buffer | undefined = isSourceName(name) ? Buffer.alloc(0) : undefined
  for await (const chunk of chunks) {
    signal?.throwIfAborted()
    if (head !== undefined) {
      head = Buffer.concat([head, chunk.subarray(0, CLASSIFY_HEAD_BYTES - head.length)])
      if (head.length >= CLASSIFY_HEAD_BYTES) {
        const problem = scriptProblem(name, head)
        head = undefined
        if (problem !== undefined) return problem
      }
    }
    if (keys.sees(chunk)) return PRIVATE_KEY_REASON
  }
  return head === undefined ? undefined : scriptProblem(name, head)
}
