import { foldCase } from "../fold"
import { extensionOf } from "./kind"
import { BUNDLE, BUNDLE_EXTENSIONS } from "./kind-lists"
import { hasMisleadingCharacters } from "./name-characters"

/** The longest one component of a path may be, in bytes: what every file system takes. */
const MAX_COMPONENT_BYTES = 255

/** The longest a whole path may be, in bytes. */
const MAX_PATH_BYTES = 1024

const COLON = ":"
const NOTHING_BUT_DOTS_AND_SPACES = /^[. ]*$/
const ENDS_IN_DOT_OR_SPACE = /[. ]$/

/**
 * Names Windows opens as devices, with or without an extension and in any
 * case: CON, PRN, AUX, NUL, CONIN$, CONOUT$ and COM or LPT with a digit or a
 * superscript digit. Only the part before the first dot counts.
 */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])$/i

/** Whether a path component is a name Windows reserves for a device, with or without an extension. */
export function isReservedDeviceName(component: string): boolean {
  return RESERVED_DEVICE_NAME.test(component.split(".")[0]!.trimEnd())
}

const NOT_PLAIN = "a path that is not a plain relative one"

/**
 * Why a name is not a plain relative path, or `undefined` when it is: no
 * leading `/`, no `\`, no NUL, no `:` anywhere (a drive letter, or an
 * alternate data stream on Windows), no empty component (one `/` may end a
 * directory's name), no component that ends in a dot or a space (Windows drops
 * them, so `.. ` is `..` and `a.` is `a`), no component that is a Windows
 * device name (`CON`, `NUL.txt`, `COM1`, …), no component over 255 bytes, no
 * path over 1024, and no control or bidi control character
 * (`hasMisleadingCharacters`). The name is judged as the archive wrote it.
 */
export function plainPathProblem(name: string, dir: boolean): string | undefined {
  if (name.startsWith("/")) return `${NOT_PLAIN} (it is absolute)`
  if (name.includes("\\")) return `${NOT_PLAIN} (it has a backslash)`
  if (name.includes("\0")) return `${NOT_PLAIN} (it has a NUL)`
  if (Buffer.byteLength(name) > MAX_PATH_BYTES) return `${NOT_PLAIN} (it is over ${MAX_PATH_BYTES} bytes)`
  const components = (dir && name.endsWith("/") ? name.slice(0, -1) : name).split("/")
  if (name.includes(COLON)) return `${NOT_PLAIN} (it has a colon: a drive letter or a stream)`
  for (const component of components) {
    if (NOTHING_BUT_DOTS_AND_SPACES.test(component)) return `${NOT_PLAIN} (it has an empty or dotted component)`
    if (ENDS_IN_DOT_OR_SPACE.test(component)) return `${NOT_PLAIN} (a component ends in a dot or a space)`
    if (isReservedDeviceName(component)) {
      return `${NOT_PLAIN} (a component is a name Windows reserves for a device)`
    }
    if (Buffer.byteLength(component) > MAX_COMPONENT_BYTES) {
      return `${NOT_PLAIN} (a component is over ${MAX_COMPONENT_BYTES} bytes)`
    }
  }
  if (hasMisleadingCharacters(name)) return "a name with control or direction-changing characters"
  return undefined
}

/**
 * Why a path would make an app or system bundle when unpacked, or
 * `undefined`: some component, a directory's or the file's own, ends in a
 * bundle extension (`BUNDLE_EXTENSIONS`, read as `classifyFile` reads one).
 */
export function bundleProblem(name: string): string | undefined {
  const bundled = name.split("/").some((component) => BUNDLE_EXTENSIONS.includes(extensionOf(component)))
  return bundled ? BUNDLE : undefined
}

/** A path folded for comparison, component by component so that a character folding into `/` cannot join two. */
function pathKey(name: string): string[] {
  return name
    .replace(/\/$/, "")
    .split("/")
    .map((component) => foldCase(component))
}

/**
 * The paths an archive has used, kept to catch what would collide once
 * unpacked: two entries for one path, also when they differ only in case or
 * Unicode form (a case-insensitive file system would let one overwrite the
 * other), and a path used both as a file and as a directory.
 */
export class PathRegistry {
  readonly #entries = new Map<string, "file" | "dir">()
  readonly #implicitDirs = new Set<string>()

  /** Records an entry; returns why it collides with an earlier one, or `undefined`. */
  add(name: string, dir: boolean): string | undefined {
    const parts = pathKey(name)
    const key = parts.join("/")
    if (this.#entries.has(key)) {
      return "a second entry for the same path (names that differ only in case or form are the same path)"
    }
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/")
      if (this.#entries.get(parent) === "file") return "inside a path that is also a file"
      this.#implicitDirs.add(parent)
    }
    if (!dir && this.#implicitDirs.has(key)) return "a file whose path is also a directory"
    this.#entries.set(key, dir ? "dir" : "file")
    return undefined
  }
}
