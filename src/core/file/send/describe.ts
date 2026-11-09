import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { CLASSIFY_HEAD_BYTES } from "../../archive/kind"
import { CHUNK_SIZE } from "../../archive/streams"
import { ToolError } from "../../errors"
import { sizeFact } from "../../facts"
import type { DescribedChat } from "../../message/describe"
import { assertResolvedFile } from "../../outgoing/identity"
import { MAX_TOTAL_BYTES } from "../../outgoing/limits"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../../tool"
import { SEND_AS, type SendAs } from "../../whatsapp/file-send"
import { kindOf, type SendKind } from "./kinds"
import { resolveFiles, type ResolvedFile } from "./resolve-files"
import { assertApproved, openResolved, overTotalLimit, type ByteBudget } from "./stage"
import { FILE_SEND_WORDS } from "./words"

/** A file of a send as its prompt tells it: the name it is sent under, its size and SHA-256, and how it is shown. */
export type DescribedFile = { name: string; size: number; sha256: string; kind: SendKind }

/** The words that tell a file shown as `SendAs`: as the one value of a single file, and as the label of the count among several. */
const SENT_AS: Record<SendAs, { value: string; label: string }> = {
  image: { value: FILE_SEND_WORDS.photo, label: FILE_SEND_WORDS.photos },
  video: { value: FILE_SEND_WORDS.video, label: FILE_SEND_WORDS.videos },
  audio: { value: FILE_SEND_WORDS.audio, label: FILE_SEND_WORDS.audioFiles },
  document: { value: FILE_SEND_WORDS.document, label: FILE_SEND_WORDS.documents },
}

/**
 * Reads the file that was resolved as staging would, without copying it: opened without following a link and checked
 * on the descriptor to be the file that was resolved, then read to its end once for its size, its SHA-256 and the
 * first bytes that tell its kind. A SHA-256 the caller approved that differs is `stale`, an empty file `forbidden`,
 * and the bytes count against `budget`.
 */
async function readFile(
  { shown, sha256: expected, resolved }: ResolvedFile,
  budget: ByteBudget,
  asDocument: boolean,
  signal?: AbortSignal,
): Promise<DescribedFile> {
  const file = await openResolved(resolved, shown)
  try {
    assertResolvedFile(await file.stat({ bigint: true }), resolved.identity, shown)
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(CHUNK_SIZE)
    let head = Buffer.alloc(0)
    let size = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, CHUNK_SIZE, null)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      size += bytesRead
      budget.used += bytesRead
      if (budget.used > budget.limit) throw overTotalLimit(budget.limit)
      hash.update(chunk)
      if (head.length < CLASSIFY_HEAD_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, CLASSIFY_HEAD_BYTES - head.length)])
      }
    }
    if (size === 0) throw new ToolError("forbidden", `${shown} cannot be sent: it is an empty file.`)
    const sha256 = hash.digest("hex")
    assertApproved(shown, expected, sha256)
    return { name: resolved.name, size, sha256, kind: kindOf(resolved.name, head, { asDocument }) }
  } finally {
    await file.close()
  }
}

/**
 * The files of a send as its prompt tells them, in the order given. Every file is resolved first (`resolveFiles`), so
 * one the send rules refuse by where it is or what it is called throws before any file's bytes are read; then each
 * is read from its real path (`readFile`). It does not inspect archives or scan contents: that stays with the send.
 */
export async function describeFiles(
  files: readonly { path: string; sha256?: string }[],
  ctx: Pick<ToolContext, "cwd" | "sendDirs" | "stateDir" | "ownDir" | "signal">,
  { asDocument }: { asDocument: boolean },
): Promise<DescribedFile[]> {
  const resolved = await resolveFiles(files, ctx)
  const budget: ByteBudget = { used: 0, limit: MAX_TOTAL_BYTES }
  const described: DescribedFile[] = []
  for (const file of resolved) described.push(await readFile(file, budget, asDocument, ctx.signal))
  return described
}

/** How the files are shown: the one value of a single file, else a count per kind present, photos first. */
function sentAsFacts(files: readonly DescribedFile[]): CallFact[] {
  if (files.length === 1) {
    return [{ label: FILE_SEND_WORDS.sentAsLabel, value: { text: SENT_AS[files[0]!.kind.as].value } }]
  }
  return SEND_AS.flatMap((as) => {
    const count = files.filter(({ kind }) => kind.as === as).length
    return count === 0 ? [] : [{ label: SENT_AS[as].label, value: String(count) }]
  })
}

/** What a file send's prompt tells: the headline, the chat and reply facts, how the files are shown, their size, the caption, and each file's SHA-256 as a pin. */
export function fileSendDescription(
  chat: DescribedChat,
  reply: CallFact | undefined,
  files: readonly DescribedFile[],
  caption: string | undefined,
): CallDescription {
  const headline: CallHeadline =
    files.length === 1
      ? { text: FILE_SEND_WORDS.headlineOne, values: { file: files[0]!.name, chat: chat.name } }
      : { text: FILE_SEND_WORDS.headlineSeveral, values: { chat: chat.name } }
  const totalBytes = files.reduce((total, { size }) => total + size, 0)
  return {
    headline,
    facts: [chat.fact, ...(reply === undefined ? [] : [reply]), ...sentAsFacts(files), sizeFact(totalBytes)],
    ...(caption === undefined ? {} : { text: { label: FILE_SEND_WORDS.textLabel, body: caption } }),
    pins: Object.fromEntries(files.map(({ sha256 }, position) => [`sha256:${position}`, sha256])),
  }
}
