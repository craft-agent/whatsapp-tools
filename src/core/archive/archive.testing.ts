import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArchiveRefused } from "./refused"

/** A temp directory for archives a test builds; `remove` deletes it with everything in it. */
export type Fixtures = {
  /** Writes the bytes to a file of the given name and returns its path. */
  write(name: string, content: Uint8Array): string
  remove(): void
}

/** Creates a temporary directory for archive fixtures. */
export function createFixtures(): Fixtures {
  const dir = mkdtempSync(join(tmpdir(), "archive-"))
  return {
    write(name, content) {
      const path = join(dir, name)
      writeFileSync(path, content)
      return path
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Runs `action` and returns the `ArchiveRefused` it throws; any other outcome is a failure of the test. */
export async function refusal(action: () => Promise<unknown>): Promise<ArchiveRefused> {
  try {
    await action()
  } catch (error) {
    if (error instanceof ArchiveRefused) return error
    throw error
  }
  throw new Error("expected the archive to be refused")
}

/** An ELF header long enough for the checks, to hide under an innocent name. */
export const ELF_BYTES = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(56)])
/** A Mach-O header long enough for the checks, to hide under an innocent name. */
export const MACHO_BYTES = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), Buffer.alloc(56)])
/** A PE header long enough for the checks, to hide under an innocent name. */
export const PE_BYTES = Buffer.concat([
  Buffer.from("MZ"),
  Buffer.alloc(0x3a),
  Buffer.from([0x80, 0, 0, 0]),
  Buffer.alloc(64),
])
