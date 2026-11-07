import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALICE, at, wacliChat, wacliMessage } from "../chat/read.testing"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { invoke, type ToolContext } from "../tool"
import type { LabelPaths } from "../whatsapp/labels"
import { serviceOperations } from "../whatsapp/operations"
import { DOCTOR_OK, HANGING_SYNC, startService, syncFixture, type SyncFixture } from "../whatsapp/sync.testing"
import { resetWacliCache } from "../whatsapp/wacli"
import type { FakeCall, FakeResponse, FakeWacli } from "../whatsapp/wacli.testing"
import { createFileSave, type FileSaveHost } from "./save"
import type { FileSaveOutput } from "./schema"

/** A made-up message id, in the form wacli gives them. */
export const MESSAGE_ID = "3EB0A1B2C3D4E5F6"

/** What the mirror says of the file the message carries; the rest is a plain incoming message. */
export type MediaInit = {
  /** wacli's media type; `document` by default, empty for a message with no file. */
  kind?: string
  /** The file name the sender gave it; `notes.txt` by default, empty for none. */
  name?: string
  /** The content type the message declares; `text/plain` by default, empty for none. */
  type?: string
}

/** The arguments that save the message `MESSAGE_ID` of Alice's chat. */
export function saveArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { chat: ALICE, id: MESSAGE_ID, ...extra }
}

/** The response of the fake to a download: it writes `content` where it was told to and reports it. */
export function download(content: string | Buffer, also: Partial<FakeResponse> = {}): FakeResponse {
  const writeOutput = typeof content === "string" ? { text: content } : { base64: content.toString("base64") }
  return { args: ["media", "download"], writeOutput, ...also }
}

/** A linked label with a fake wacli, a download directory and the tool. */
export type SaveFixture = {
  fake: FakeWacli
  stateDir: string
  downloadDir: string
  paths: LabelPaths
  /** The folder of the message `MESSAGE_ID`. */
  folder: string
  /** The programs the fake runner was asked to run, in order. */
  runs: string[][]
  /** Sets the message the mirror holds. */
  message(media?: MediaInit): void
  /** Sets what the fake wacli answers, the sync service's own calls included. */
  respond(...responses: FakeResponse[]): void
  /** Starts the sync service with its own operations; it answers with the fake's calls, so `respond` comes after it. */
  startService(): Promise<void>
  /** Stops the sync service, and resolves once it has ended. */
  stopService(): Promise<void>
  /** The fake's calls of `media download`. */
  downloadCalls(): Promise<FakeCall[]>
  /** Calls the tool; `host` replaces parts of the machine, `ctx` parts of the context. */
  save(
    args: Record<string, unknown>,
    options?: { host?: Partial<FileSaveHost>; ctx?: Partial<ToolContext> },
  ): Promise<FileSaveOutput>
  /** The error a call throws. */
  failure(
    args: Record<string, unknown>,
    options?: { host?: Partial<FileSaveHost>; ctx?: Partial<ToolContext> },
  ): Promise<ToolError>
  /** The names in the message's folder's parent: the message's folder and whatever else is there. */
  siblings(): string[]
  close(): Promise<void>
}

export async function createSaveFixture(): Promise<SaveFixture> {
  resetWacliCache()
  const sync = await syncFixture()
  const { fake, stateDir, paths } = sync
  mkdirSync(paths.dir, { recursive: true })
  const downloadDir = realpathSync(mkdtempSync(join(tmpdir(), "dl-")))
  const originalPath = process.env.PATH
  process.env.PATH = fake.env.PATH
  let service: ReturnType<SyncFixture["start"]> | undefined

  const runs: string[][] = []
  const ok: ExecResult = { code: 0, stdout: "", stderr: "" }
  const context = (extra: Partial<ToolContext> = {}): ToolContext => ({
    cwd: stateDir,
    stateDir,
    downloadDir,
    programName: "whatsapp-tools",
    ...extra,
  })
  const tool = (host: Partial<FileSaveHost> = {}) =>
    createFileSave({
      platform: "linux",
      run: async (argv) => {
        runs.push(argv)
        return ok
      },
      now: () => 1_700_000_123_000,
      uuid: () => "11111111-2222-4333-8444-555555555555",
      ...host,
    })
  const message: SaveFixture["message"] = ({ kind = "document", name = "notes.txt", type = "text/plain" } = {}) =>
    fake.setMirror({
      chats: [wacliChat({ jid: ALICE })],
      messages: [
        wacliMessage({
          id: MESSAGE_ID,
          chat: ALICE,
          at: at(1),
          MediaType: kind,
          Filename: name,
          MimeType: type,
          DisplayText: kind === "" ? "hello" : "(message)",
          Text: kind === "" ? "hello" : "",
        }),
      ],
    })
  const respond: SaveFixture["respond"] = (...responses) => fake.setResponses([DOCTOR_OK, HANGING_SYNC, ...responses])
  message()

  return {
    fake,
    stateDir,
    downloadDir,
    paths,
    folder: join(downloadDir, paths.label, ALICE, MESSAGE_ID),
    runs,
    message,
    respond,
    async startService() {
      service = await startService(sync, serviceOperations())
    },
    async stopService() {
      service?.stop()
      await service?.outcome
    },
    async downloadCalls() {
      return (await fake.calls()).filter((call) => call.argv.includes("download"))
    },
    save: (args, options = {}) => invoke(tool(options.host), args, context(options.ctx)),
    async failure(args, options = {}) {
      try {
        await invoke(tool(options.host), args, context(options.ctx))
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    siblings: () =>
      existsSync(join(downloadDir, paths.label, ALICE)) ? readdirSync(join(downloadDir, paths.label, ALICE)) : [],
    async close() {
      service?.stop()
      await service?.outcome
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      resetWacliCache()
      await sync.cleanup()
      rmSync(downloadDir, { recursive: true, force: true })
    },
  }
}

/** A signal that says "cancelled" from its `after`th check on; the tool checks before the download and each chunk it copies. */
export function abortAfter(after: number): AbortSignal {
  const controller = new AbortController()
  const { signal } = controller
  const check = signal.throwIfAborted.bind(signal)
  let checks = 0
  signal.throwIfAborted = () => {
    if (++checks > after) controller.abort()
    check()
  }
  return signal
}
