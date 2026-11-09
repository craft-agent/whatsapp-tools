import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolError } from "../errors"
import { FILE_SEND_OP } from "./file-send"
import { CHAT, ID, REPLY_TO, startFileSendService, type FileSendServiceTest } from "./file-send.testing"
import { serviceOperations } from "./operations"

let s: FileSendServiceTest

beforeEach(async () => {
  s = await startFileSendService()
})

afterEach(async () => {
  await s.close()
})

describe("the file_send operation", () => {
  test("is a delegated one that writes, so that a stop or a deadline during it is uncertain", () => {
    expect(serviceOperations()[FILE_SEND_OP]).toMatchObject({ kind: "delegated", writes: true })
  })

  test("runs wacli without --read-only, with the file, its name, how it is shown, its type and the time left it", async () => {
    s.answerSend({ stdout: s.sentEnvelope() })
    await s.ask(s.request({ caption: "--help -x", reply_to: REPLY_TO }))
    const [call, ...others] = await s.sendCalls()
    expect(others).toEqual([])
    expect(call!.argv).toEqual([
      "--store",
      s.fixture.paths.store,
      "--json",
      "send",
      "file",
      "--timeout",
      "45s",
      "--to",
      CHAT,
      "--file",
      s.file,
      "--filename",
      "photo.jpg",
      "--as",
      "image",
      "--mime",
      "image/jpeg",
      "--caption",
      "--help -x",
      "--reply-to",
      REPLY_TO,
    ])
    expect(call!.env).toEqual({ WACLI_MEDIA_ROOTS: s.fixture.paths.outbox })
  })

  test("leaves out the caption and the quote when there are none, and gives wacli at least a second", async () => {
    s.answerSend({ stdout: s.sentEnvelope() })
    await s.ask(s.request({ timeout_ms: 10_000 }))
    const [call] = await s.sendCalls()
    expect(call!.argv.slice(5, 7)).toEqual(["--timeout", "1s"])
    expect(call!.argv).not.toContain("--caption")
    expect(call!.argv).not.toContain("--reply-to")
  })

  test("answers with the id, when it was accepted, how WhatsApp showed the file and what wacli says of the mirror", async () => {
    s.answerSend({ stdout: s.sentEnvelope({ file: { media: "document" } }) })
    const before = Date.now()
    const answer = (await s.ask(s.request())) as { id: string; as: string; accepted_ms: number }
    expect(answer).toMatchObject({ id: ID, as: "document" })
    expect(answer.accepted_ms).toBeGreaterThanOrEqual(before)
    expect(answer).not.toHaveProperty("store_warning")

    s.answerSend({
      stdout: s.sentEnvelope({ file: undefined, store_warning: "message update: disk full for 15550100001" }),
    })
    expect(await s.ask(s.request())).toMatchObject({
      id: ID,
      as: "image",
      store_warning: "message update: disk full for <number>",
    })
  })

  test("takes 1024 characters of caption counted as code points and refuses 1025", async () => {
    s.answerSend({ stdout: s.sentEnvelope() })
    expect(await s.ask(s.request({ caption: "😀".repeat(1024) }))).toMatchObject({ id: ID })
    expect(((await s.ask(s.request({ caption: "😀".repeat(1025) }))) as ToolError).code).toBe("invalid_argument")
    expect(await s.sendCalls()).toHaveLength(1)
  })

  test.each([
    ["a chat that is not a JID", { chat: "Alice" }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["a file that is not absolute", { file: "photo.jpg" }],
    ["an empty name", { name: "" }],
    ["a name with a slash", { name: "a/b.jpg" }],
    ["a way of showing it that wacli has not", { as: "sticker" }],
    ["a type with parameters", { mime: "audio/ogg; codecs=opus" }],
    ["a type that is too long", { mime: `text/${"a".repeat(125)}` }],
    ["an empty caption", { caption: "" }],
    ["a caption with a NUL", { caption: "a\0b" }],
    ["half of a character in a caption", { caption: "a\uD83D" }],
    ["a reply_to that is not a message id", { reply_to: "-x" }],
    ["less time than the least", { timeout_ms: 9_999 }],
    ["more time than the most", { timeout_ms: 280_001 }],
    ["a time that is not whole", { timeout_ms: 30_000.5 }],
    ["an argument it does not know", { ptt: true }],
  ])("refuses %s as invalid_argument, and runs nothing", async (_what, change) => {
    s.answerSend({ stdout: s.sentEnvelope() })
    const error = await s.ask(s.request(change))
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect(await s.sendCalls()).toEqual([])
  })

  test("refuses a file that is not inside the outbox, a directory and a file that is not there, and runs nothing", async () => {
    s.answerSend({ stdout: s.sentEnvelope() })
    const { paths, stateDir } = s.fixture
    const outside = join(stateDir, "elsewhere.jpg")
    writeFileSync(outside, "bytes")
    const link = join(paths.outbox, "0123", "link.jpg")
    symlinkSync(outside, link)
    for (const path of [
      outside,
      link,
      join(paths.outbox, "0123"),
      paths.outbox,
      join(paths.outbox, "0123", "gone.jpg"),
    ]) {
      const error = await s.ask(s.request({ file: path }))
      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("invalid_argument")
      expect((error as ToolError).message).toContain("Nothing was sent")
    }
    expect(await s.sendCalls()).toEqual([])
  })

  test("is uncertain when the service's deadline passes while wacli has not answered, and wacli is stopped", async () => {
    s.answerSend({ hang: true })
    const error = await s.ask(s.request({ timeout_ms: 10_000 }), 3000)
    expect((error as ToolError).code).toBe("uncertain")
    expect(await s.sendCalls()).toHaveLength(1)
  })

  test("is uncertain when wacli outlasts the time it was given, which is 5 seconds under the request's", async () => {
    s.answerSend({ hang: true })
    const started = Date.now()
    const error = await s.ask(s.request({ timeout_ms: 10_000 }), 20_000)
    expect((error as ToolError).code).toBe("uncertain")
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await s.sendCalls()).toHaveLength(1)
  }, 15_000)
})
