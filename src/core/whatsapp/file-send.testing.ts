import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../errors"
import { FILE_SEND_OP } from "./file-send"
import { serviceOperations } from "./operations"
import { callService } from "./service-client"
import { DOCTOR_OK, HANGING_SYNC, startService, syncFixture, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { envelope, type FakeCall, type FakeResponse } from "./wacli.testing"

export const CHAT = "15550100001@s.whatsapp.net"
export const ID = "3EB0A1B2C3D4E5F6"
export const REPLY_TO = "3EB0F6E5D4C3B2A1"

/** The time a request gives its file unless a test says otherwise. */
export const TIMEOUT_MS = 60_000

/** A real service with a fake wacli, and a file in the label's outbox to send. */
export type FileSendServiceTest = {
  fixture: SyncFixture
  /** The file of the outbox the requests name. */
  file: string
  /** Has the fake answer `send file` as `response` says. */
  answerSend(response: Omit<FakeResponse, "args">): void
  /** What wacli prints for a file it sent, with `data` over the usual fields. */
  sentEnvelope(data?: Record<string, unknown>): string
  /** The arguments of a request for `file`, with `change` over them. */
  request(change?: Record<string, unknown>): Record<string, unknown>
  /** Calls the operation and returns what it answers, or the error it fails with. */
  ask(args: unknown, timeoutMs?: number): Promise<unknown>
  /** The fake's calls of `send`. */
  sendCalls(): Promise<FakeCall[]>
  close(): Promise<void>
}

/** Starts a service with the CLI's operations for a test; call `close` afterwards. */
export async function startFileSendService(): Promise<FileSendServiceTest> {
  resetWacliCache()
  const fixture = await syncFixture()
  const folder = join(fixture.paths.outbox, "0123")
  mkdirSync(folder, { recursive: true })
  const file = join(folder, "photo.jpg")
  writeFileSync(file, "bytes")
  const service = await startService(fixture, serviceOperations())
  return {
    fixture,
    file,
    answerSend: (response) =>
      fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["send", "file"], ...response }]),
    sentEnvelope: (data = {}) => envelope({ sent: true, to: CHAT, id: ID, file: { media: "image" }, ...data }),
    request: (change = {}) => ({
      chat: CHAT,
      file,
      name: "photo.jpg",
      as: "image",
      mime: "image/jpeg",
      timeout_ms: TIMEOUT_MS,
      ...change,
    }),
    ask: (args, timeoutMs = TIMEOUT_MS) =>
      callService(fixture.paths, FILE_SEND_OP, args, { mode: "write", timeoutMs }).catch((error: unknown) => {
        if (error instanceof ToolError) return error
        throw error
      }),
    sendCalls: async () => (await fixture.fake.calls()).filter((call) => call.argv.includes("send")),
    async close() {
      service.stop()
      await service.outcome
      await fixture.cleanup()
    },
  }
}
