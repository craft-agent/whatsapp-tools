import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../errors"
import { MEDIA_DOWNLOAD_OP } from "./media"
import { serviceOperations } from "./operations"
import { callService } from "./service-client"
import { DOCTOR_OK, HANGING_SYNC, startService, syncFixture, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"
import { failure } from "./wacli.testing"

const CHAT = "15550100001@s.whatsapp.net"
const ID = "3EB0A1B2C3D4E5F6"

let fixture: SyncFixture
let service: Awaited<ReturnType<typeof startService>> | undefined
let output: string

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
  mkdirSync(fixture.paths.dir, { recursive: true })
  output = join(fixture.stateDir, ".staging")
  mkdirSync(output, { mode: 0o700 })
  chmodSync(output, 0o700)
  service = await startService(fixture, serviceOperations())
  fixture.fake.setResponses([DOCTOR_OK, HANGING_SYNC, { args: ["media", "download"], writeOutput: { text: "bytes" } }])
})

afterEach(async () => {
  service?.stop()
  await service?.outcome
  service = undefined
  await fixture.cleanup()
})

const ask = (args: unknown) =>
  callService(fixture.paths, MEDIA_DOWNLOAD_OP, args, { mode: "write", timeoutMs: 20_000 }).catch(
    (error: unknown) => error as ToolError,
  )

/** The calls the fake got for the download. */
const downloadCalls = async () => (await fixture.fake.calls()).filter((call) => call.argv.includes("download"))

describe("the media_download operation", () => {
  test("is a delegated one that writes, so that a stop or a deadline during it is uncertain", () => {
    expect(serviceOperations()[MEDIA_DOWNLOAD_OP]).toMatchObject({ kind: "delegated", writes: true })
  })

  test("runs wacli without --read-only and with --retry-on-phone, and answers with what wacli wrote", async () => {
    const file = join(output, "file")
    expect(await ask({ chat: CHAT, id: ID, output: file })).toEqual({ path: file, bytes: 5, source: "phone" })

    const [call, ...others] = await downloadCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual([
      "--store",
      fixture.paths.store,
      "--json",
      "media",
      "download",
      "--chat",
      CHAT,
      "--id",
      ID,
      "--output",
      file,
      "--retry-on-phone",
    ])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: fixture.paths.outbox })
  })

  test.each([
    ["a chat that is not a JID", { chat: "Alice" }],
    ["a missing chat", { chat: undefined }],
    ["an id that is not a message id", { id: "../x" }],
    ["an id that starts with a dash", { id: "-x" }],
    ["a missing id", { id: undefined }],
    ["a missing output", { output: undefined }],
    ["an output that is not text", { output: 5 }],
    ["an output that is not absolute", { output: "relative/file" }],
    ["an output in a folder that does not exist", { output: "/nonexistent-folder/file" }],
    ["an argument it does not know", { retry: true }],
  ])("refuses %s as invalid_argument, and runs nothing", async (_what, change) => {
    const error = await ask({ chat: CHAT, id: ID, output: join(output, "file"), ...change })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await downloadCalls()).toEqual([])
  })

  test("refuses an output whose folder is a link or a file", async () => {
    symlinkSync(output, join(fixture.stateDir, ".link"))
    writeFileSync(join(fixture.stateDir, ".afile"), "x")
    for (const folder of [".link", ".afile"]) {
      const error = await ask({ chat: CHAT, id: ID, output: join(fixture.stateDir, folder, "file") })
      expect((error as ToolError).code).toBe("invalid_argument")
    }
    expect(await downloadCalls()).toEqual([])
  })

  test("refuses an existing file as output", async () => {
    const file = join(output, "file")
    writeFileSync(file, "already here")
    const error = await ask({ chat: CHAT, id: ID, output: file })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await downloadCalls()).toEqual([])
  })

  test("refuses a parent that is a link", async () => {
    const link = join(fixture.stateDir, ".link-parent")
    symlinkSync(output, link)
    const error = await ask({ chat: CHAT, id: ID, output: join(link, "file") })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await downloadCalls()).toEqual([])
  })

  test("refuses a parent that is not 0700", async () => {
    const openDir = join(fixture.stateDir, ".open")
    mkdirSync(openDir, { mode: 0o755 })
    chmodSync(openDir, 0o755)
    const error = await ask({ chat: CHAT, id: ID, output: join(openDir, "file") })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await downloadCalls()).toEqual([])
  })

  test("refuses a parent not starting with .", async () => {
    const plainDir = join(fixture.stateDir, "plain")
    mkdirSync(plainDir, { mode: 0o700 })
    chmodSync(plainDir, 0o700)
    const error = await ask({ chat: CHAT, id: ID, output: join(plainDir, "file") })
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await downloadCalls()).toEqual([])
  })

  test("answers what wacli prints that cannot be read as upstream_error", async () => {
    fixture.fake.setResponses([
      DOCTOR_OK,
      HANGING_SYNC,
      {
        args: ["media", "download"],
        writeOutput: { text: "x" },
        stdout: '{"success":true,"data":{"path":1},"error":null}\n',
      },
    ])
    const error = await ask({ chat: CHAT, id: ID, output: join(output, "file") })
    expect((error as ToolError).code).toBe("upstream_error")
  })

  test("keeps wacli's own refusal of a call as invalid_argument", async () => {
    fixture.fake.setResponses([
      DOCTOR_OK,
      HANGING_SYNC,
      { args: ["media", "download"], stderr: failure("unknown flag: --retry-on-phone"), exit: 1 },
    ])
    const error = await ask({ chat: CHAT, id: ID, output: join(output, "file") })
    expect((error as ToolError).code).toBe("invalid_argument")
  })
})
