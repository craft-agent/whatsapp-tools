import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ToolError } from "../errors"
import { OutgoingRefused } from "./refused"

/** A temp directory, by real path, for the files and links a test makes; `remove` deletes everything in it. */
export type Sandbox = {
  /** The directory itself. */
  root: string
  /** Writes a file (making its folders) at a path below the root and returns the full path. */
  write(path: string, content?: string | Uint8Array): string
  /** Makes a folder (and its parents) below the root and returns the full path. */
  mkdir(path: string): string
  /** Makes a link at a path below the root to a target, which is taken as it is, and returns the link's path. */
  link(path: string, target: string): string
  remove(): void
}

export function createSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "outgoing-")))
  return {
    root,
    write(path, content = "made-up content\n") {
      const full = join(root, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
      return full
    },
    mkdir(path) {
      const full = join(root, path)
      mkdirSync(full, { recursive: true })
      return full
    },
    link(path, target) {
      const full = join(root, path)
      mkdirSync(dirname(full), { recursive: true })
      symlinkSync(target, full)
      return full
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  }
}

const DASHES = "-----"

/**
 * A made-up private key: the first line of a real block (assembled from parts
 * so that no secret scanner takes this file for one) and a body that is not a
 * key. `label` goes between `BEGIN` and `PRIVATE KEY`, `suffix` after it.
 */
export function fakeKey(label = "", suffix = ""): string {
  return [
    `${DASHES}BEGIN ${label}PRIVATE KEY${suffix}${DASHES}`,
    "FAKEFAKEFAKEFAKEFAKEFAKE",
    "FAKEFAKEFAKE",
    `${DASHES}END ${label}PRIVATE KEY${suffix}${DASHES}`,
    "",
  ].join("\n")
}

/** A made-up key in the ssh.com format (the first line is assembled from parts, as `fakeKey`'s is). */
export function fakeSsh2Key(encrypted: boolean): string {
  const kind = encrypted ? "SSH2 ENCRYPTED " : "SSH2 "
  return [
    `${"----"} BEGIN ${kind}PRIVATE KEY ${"----"}`,
    "Comment: made up",
    "FAKEFAKEFAKEFAKE",
    `${"----"} END ${kind}PRIVATE KEY ${"----"}`,
    "",
  ].join("\n")
}

/** A made-up key in PuTTY's format, of the given file version. */
export function fakePuttyKey(version: number): string {
  return [`${"PuTTY-User-Key-"}File-${version}: ssh-rsa`, "Encryption: none", "Comment: made up", "FAKEFAKE", ""].join(
    "\n",
  )
}

/** `text` in UTF-16 as a file holds it: little- or big-endian, with or without a byte order mark. */
export function utf16(text: string, order: "le" | "be", bom: boolean): Buffer {
  const little = Buffer.from(text, "utf16le")
  const body = order === "le" ? little : Buffer.from(little).swap16()
  const mark = Buffer.from(order === "le" ? [0xff, 0xfe] : [0xfe, 0xff])
  return bom ? Buffer.concat([mark, body]) : body
}

/** `text` in UTF-32 as a file holds it: little- or big-endian, with or without a byte order mark. */
export function utf32(text: string, order: "le" | "be", bom: boolean): Buffer {
  const units = [...((bom ? "\ufeff" : "") + text)].map((character) => {
    const unit = Buffer.alloc(4)
    if (order === "le") unit.writeUInt32LE(character.codePointAt(0)!)
    else unit.writeUInt32BE(character.codePointAt(0)!)
    return unit
  })
  return Buffer.concat(units)
}

/** The bytes in pieces of `size`, the last one shorter, as a reader hands them out. */
export async function* pieces(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size)
}

/** Runs `action` and returns the `ToolError` it throws; any other outcome is a failure of the test. */
export async function toolFailure(action: () => Promise<unknown>): Promise<ToolError> {
  try {
    await action()
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("expected a ToolError")
}

/** Runs `action` and returns the `OutgoingRefused` it throws; any other outcome is a failure of the test. */
export async function outgoingRefusal(action: () => Promise<unknown>): Promise<OutgoingRefused> {
  try {
    await action()
  } catch (error) {
    if (error instanceof OutgoingRefused) return error
    throw error
  }
  throw new Error("expected the file to be refused")
}
