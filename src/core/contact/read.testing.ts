import { mkdirSync, rmSync } from "node:fs"
import { ToolError } from "../errors"
import { invoke } from "../tool"
import { labelPaths } from "../whatsapp/labels"
import { shortTempDir } from "../whatsapp/sync.testing"
import { resetWacliCache } from "../whatsapp/wacli"
import { installFakeWacli, type FakeWacli } from "../whatsapp/wacli.testing"
import { whatsappContactRead } from "./read"
import type { ContactReadOutput } from "./schema"

export const ANN = "15550100001@s.whatsapp.net"
export const BOB = "15550100002@s.whatsapp.net"
export const CY = "15550100003@s.whatsapp.net"
export const HIDDEN = "99887766554433@lid"
export const LABEL = "main"

/** A contact as `wacli contacts search` prints it. */
export function wacliContact(jid: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jid,
    phone: jid.endsWith("@s.whatsapp.net") ? jid.slice(0, jid.indexOf("@")) : "",
    name,
    alias: "",
    system_name: "",
    updated_at: "2026-11-07T05:00:00Z",
    ...extra,
  }
}

/** Runs the tool on `stateDir`, with the `exclude_chats` setting `excluded` if given, and returns its result. */
export function readContacts(stateDir: string, args: unknown, excluded?: string[]): Promise<ContactReadOutput> {
  const options = excluded && { exclude_chats: excluded }
  return invoke(whatsappContactRead, args, { cwd: stateDir, stateDir, options })
}

/** Runs the tool on `stateDir` and returns the error it throws. */
export async function failureOf(stateDir: string, args: unknown, excluded?: string[]): Promise<ToolError> {
  try {
    await readContacts(stateDir, args, excluded)
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("expected the call to fail")
}

/** One tool call's surroundings for `search`: a paired label and a fake wacli with the contacts a test lists. */
export type ContactFixture = {
  fake: FakeWacli
  stateDir: string
  /** Sets the contacts the fake searches through. */
  setContacts(...contacts: Record<string, unknown>[]): void
  /** Sets the `exclude_chats` setting the tool runs with from now on. */
  exclude(...chats: string[]): void
  read(args: unknown): Promise<ContactReadOutput>
  failure(args: unknown): Promise<ToolError>
  close(): Promise<void>
}

/** Sets up a paired label `main` with a fake wacli on `PATH`; call `close` afterwards. */
export async function createContactFixture(): Promise<ContactFixture> {
  const stateDir = await shortTempDir()
  mkdirSync(labelPaths(stateDir, LABEL).dir)
  const fake = await installFakeWacli()
  const originalPath = process.env.PATH
  process.env.PATH = fake.env.PATH
  resetWacliCache()
  let excluded: string[] | undefined
  return {
    fake,
    stateDir,
    setContacts: (...contacts) => fake.setMirror({ contacts }),
    exclude(...chats) {
      excluded = chats
    },
    read: (args) => readContacts(stateDir, args, excluded),
    failure: (args) => failureOf(stateDir, args, excluded),
    async close() {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      resetWacliCache()
      await fake.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}
