import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MIME_PREFIXES,
  DOCUMENT_MIME_TYPES,
  GZIP_EXTENSIONS,
  GZIP_MIME_TYPES,
  MAGIC_RULES,
  PROGRAM,
  REFUSED_EXTENSIONS,
  REFUSED_MIME_PATTERNS,
  REFUSED_MIME_TYPES,
  TAR_EXTENSIONS,
  TAR_MIME_TYPES,
  ZIP_EXTENSIONS,
  ZIP_MIME_TYPES,
  type Signature,
} from "./kind-lists"
import { TAR_BLOCK_SIZE, isZeroBlock, looksLikeTarHeader } from "./tar-header"

/** The archive formats this package can read: zip, tar, and a gzipped tar. */
export type ArchiveFormat = "zip" | "tar" | "tgz"

/** What a received file is, as far as its name, declared type and first bytes say. */
export type FileKind =
  { kind: "file" } | { kind: "archive"; format: ArchiveFormat } | { kind: "refused"; reason: string }

/** How many of a file's first bytes `classifyFile` needs; it uses fewer when it is given fewer. */
export const CLASSIFY_HEAD_BYTES = 4096

const DOS_MAGIC = [0x4d, 0x5a]
const DOS_HEADER_SIZE = 0x40
const ZIP_MAGICS = [
  [0x50, 0x4b, 0x03, 0x04], // a first entry
  [0x50, 0x4b, 0x05, 0x06], // an empty archive
]
const GZIP_MAGIC = [0x1f, 0x8b, 0x08]

const NAME_STRIP = /[. ]+$/
const SEPARATORS = /[\\/]/
const MIME_PARAMETERS = /;.*$/

function matches(head: Uint8Array, { offset, bytes }: Signature): boolean {
  return head.length >= offset + bytes.length && bytes.every((byte, i) => head[offset + i] === byte)
}

function startsWith(head: Uint8Array, bytes: readonly number[]): boolean {
  return matches(head, { offset: 0, bytes })
}

/**
 * Whether the bytes are a DOS or Windows executable header. `MZ` alone also
 * starts text, so a NUL among the rest of the fixed DOS header is required,
 * which every real header has (its reserved fields and the high bytes of the
 * offset to the PE header).
 */
function isDosExecutable(head: Uint8Array): boolean {
  return startsWith(head, DOS_MAGIC) && head.length >= DOS_HEADER_SIZE && head.subarray(2, DOS_HEADER_SIZE).includes(0)
}

function refusedByBytes(head: Uint8Array): string | undefined {
  if (isDosExecutable(head)) return PROGRAM
  return MAGIC_RULES.find((rule) => rule.signatures.every((signature) => matches(head, signature)))?.reason
}

/** The extension of a file name as Windows would read it: after the last dot of its last component, without trailing dots and spaces, in lower case. */
export function extensionOf(name: string): string {
  const visible = name.split("\0")[0]!
  const base = visible.split(SEPARATORS).pop()!.replace(NAME_STRIP, "").toLowerCase()
  const dot = base.lastIndexOf(".")
  return dot === -1 ? "" : base.slice(dot + 1)
}

function mimeTypeOf(type: string): string {
  return type.replace(MIME_PARAMETERS, "").trim().toLowerCase()
}

/** Whether the name or the type says the file is a document that is a zip inside, which is saved as one file. */
function isDocument(extension: string, mimeType: string): boolean {
  return (
    DOCUMENT_EXTENSIONS.includes(extension) ||
    DOCUMENT_MIME_TYPES.includes(mimeType) ||
    DOCUMENT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))
  )
}

function formatOf(
  value: string,
  zip: readonly string[],
  tar: readonly string[],
  gzip: readonly string[],
): ArchiveFormat | undefined {
  if (zip.includes(value)) return "zip"
  if (tar.includes(value)) return "tar"
  if (gzip.includes(value)) return "tgz"
  return undefined
}

/** Every format the name's extension and the declared type each say; two that differ make a mislabeled file. */
function claimedFormats(extension: string, mimeType: string): Set<ArchiveFormat> {
  const claims = [
    formatOf(extension, ZIP_EXTENSIONS, TAR_EXTENSIONS, GZIP_EXTENSIONS),
    formatOf(mimeType, ZIP_MIME_TYPES, TAR_MIME_TYPES, GZIP_MIME_TYPES),
  ]
  return new Set(claims.filter((claim): claim is ArchiveFormat => claim !== undefined))
}

function formatByBytes(head: Uint8Array): ArchiveFormat | undefined {
  if (ZIP_MAGICS.some((magic) => startsWith(head, magic))) return "zip"
  if (startsWith(head, GZIP_MAGIC)) return "tgz"
  if (looksLikeTarHeader(head)) return "tar"
  return undefined
}

const FORMAT_LABELS: Record<ArchiveFormat, string> = { zip: "zip", tar: "tar", tgz: "gzip" }

/**
 * Judges a received file from its name, declared MIME type and first bytes
 * (give it at least `CLASSIFY_HEAD_BYTES`). Any one saying program, installer
 * or an archive format this package cannot read refuses the file. It is an
 * `archive` only when the bytes are a zip, a tar or gzip and every claim the
 * name or type makes agrees with them; a name or type that claims an archive
 * the bytes are not is a mislabeled file and is refused. Gzip is reported as
 * `tgz`: whether it holds a tar is for the inspection to find out. A document
 * that is a zip inside (`.docx`, `.epub`, …, by name or type) is a plain
 * `file`, never an archive, but only when its bytes are a zip; it claims a
 * zip like any other, so other bytes make it mislabeled. One with macros is
 * refused.
 */
export function classifyFile(file: { name?: string; type?: string; head: Uint8Array }): FileKind {
  const extension = extensionOf(file.name ?? "")
  const mimeType = mimeTypeOf(file.type ?? "")

  const reason =
    refusedByBytes(file.head) ??
    REFUSED_EXTENSIONS.get(extension) ??
    REFUSED_MIME_TYPES.get(mimeType) ??
    REFUSED_MIME_PATTERNS.find(([pattern]) => pattern.test(mimeType))?.[1]
  if (reason !== undefined) return { kind: "refused", reason }

  const claims = claimedFormats(extension, mimeType)
  // A document is a zip inside: it is a file when its bytes are one, and is judged like any other claim when they are not
  const document = isDocument(extension, mimeType)
  if (document) claims.add("zip")
  let format = formatByBytes(file.head)
  // A tar with nothing in it is two zero blocks, which says nothing without a name or type that claims a tar
  if (format === undefined && claims.has("tar") && file.head.length >= TAR_BLOCK_SIZE) {
    if (isZeroBlock(file.head.subarray(0, TAR_BLOCK_SIZE))) format = "tar"
  }

  if (claims.size === 0) return format === undefined ? { kind: "file" } : { kind: "archive", format }
  const [claim] = claims
  if (format !== undefined && claims.size === 1 && format === claim) {
    return document ? { kind: "file" } : { kind: "archive", format }
  }
  return {
    kind: "refused",
    reason: `mislabeled (its name or type says ${FORMAT_LABELS[claim!]}, its bytes do not)`,
  }
}
