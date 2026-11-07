import { Buffer } from "node:buffer"
import { isReservedDeviceName, plainPathProblem } from "../archive/entry-names"
import { hasMisleadingCharacters } from "../archive/name-characters"

/** The most bytes a file name may take: what every file system takes. */
const MAX_NAME_BYTES = 255

/** The longest extension kept apart when a name is shortened or numbered, dot included, in bytes. */
const MAX_EXTENSION_BYTES = 32

/** Characters that separate paths or that Windows does not allow in a name. */
const UNSAFE_CHARACTERS = /[/\\:<>"|?*]/

const TRAILING_DOTS_AND_SPACES = /[. ]+$/

/** The name of a file that has no usable name and no fallback that can be used. */
const LAST_RESORT_NAME = "file"

/** File extensions by the content types of the files people send. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "video/quicktime": ".mov",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/amr": ".amr",
  "audio/opus": ".opus",
  "application/pdf": ".pdf",
}

function byteLength(text: string): number {
  return Buffer.byteLength(text)
}

/** The extension a content type stands for, with its dot, or none. */
function extensionOf(type: string | undefined): string {
  return type === undefined ? "" : (EXTENSIONS[type.split(";")[0]!.trim().toLowerCase()] ?? "")
}

/** A name apart from its last extension (a dot and up to 32 bytes), which stays when the name is shortened. */
function splitExtension(name: string): [base: string, extension: string] {
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return [name, ""]
  const extension = name.slice(dot)
  return byteLength(extension) > MAX_EXTENSION_BYTES ? [name, ""] : [name.slice(0, dot), extension]
}

/** `base + suffix + extension` with the base cut, by whole characters, until it fits in 255 bytes. */
function fitted(base: string, suffix: string, extension: string): string {
  const room = MAX_NAME_BYTES - byteLength(suffix) - byteLength(extension)
  const characters = Array.from(base)
  while (characters.length > 0 && byteLength(characters.join("")) > room) characters.pop()
  return characters.join("").replace(TRAILING_DOTS_AND_SPACES, "") + suffix + extension
}

/**
 * A file name the sender gave, cleaned: NFC, with path separators, `:` and `<>"|?*`, control characters and the
 * bidi controls shown as `_`, trailing dots and spaces dropped (Windows drops them), a leading dot hidden behind
 * `_`, a Windows device name such as `CON.txt` prefixed with `_`, and at most 255 bytes of UTF-8 with the
 * extension kept. `undefined` when nothing usable is left. The result always passes the rules for a plain path
 * component that `inspectArchive` holds archive entries to.
 */
function cleanedName(raw: string): string | undefined {
  let name = Array.from(raw.normalize("NFC"), (character) =>
    UNSAFE_CHARACTERS.test(character) || hasMisleadingCharacters(character) ? "_" : character,
  )
    .join("")
    .trim()
    .replace(TRAILING_DOTS_AND_SPACES, "")
  if (name === "") return undefined
  if (name.startsWith(".") || isReservedDeviceName(name)) name = `_${name}`
  const [base, extension] = splitExtension(name)
  name = byteLength(name) > MAX_NAME_BYTES ? fitted(base, "", extension) : name
  return plainPathProblem(name, false) === undefined ? name : undefined
}

/**
 * The name a file is saved under: the one its sender gave it, cleaned (see `cleanedName`), else `fallback`, cleaned
 * the same way, else `file`.
 */
export function safeFileName(raw: string | undefined, fallback: string): string {
  return (raw === undefined ? undefined : cleanedName(raw)) ?? cleanedName(fallback) ?? LAST_RESORT_NAME
}

/**
 * The name for a file that came with none: `<kind>-<id>` and an extension for its content type, when one is known.
 * `kind` is cut to its lower-case letters and digits.
 */
export function fallbackName(kind: string, id: string, type: string | undefined): string {
  const word = kind.toLowerCase().replace(/[^a-z0-9]/g, "") || LAST_RESORT_NAME
  return `${word}-${id}${extensionOf(type)}`
}

/** `name` numbered for a second file of the same name: `photo (2).jpg`, still within 255 bytes. */
export function numberedName(name: string, number: number): string {
  const [base, extension] = splitExtension(name)
  return fitted(base, ` (${number})`, extension)
}

/** The name of the folder an archive is unpacked into, `<name>.unpacked`, or `<name> (2).unpacked` for the second, within 255 bytes. */
export function unpackedName(name: string, number = 1): string {
  return fitted(name, `${number === 1 ? "" : ` (${number})`}.unpacked`, "")
}
