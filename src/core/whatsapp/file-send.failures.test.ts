import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { ToolError, type ErrorCode } from "../errors"
import { CHAT, ID, REPLY_TO, startFileSendService, type FileSendServiceTest } from "./file-send.testing"
import { envelope, failure } from "./wacli.testing"

let s: FileSendServiceTest

beforeEach(async () => {
  s = await startFileSendService()
})

afterEach(async () => {
  await s.close()
})

const fails = (text: string) => s.answerSend({ stderr: failure(text), exit: 1 })
const asked = () => s.ask(s.request({ reply_to: REPLY_TO })) as Promise<ToolError>

describe("what wacli says when the file send fails", () => {
  test.each<[string, (path: string) => string, ErrorCode]>([
    ["no recipient or file", () => "--to and --file are required", "invalid_argument"],
    ["a file that is not a regular file", (path) => `${path} is not a regular file`, "invalid_argument"],
    [
      "a file that is too large",
      () => "file too large (209715200 bytes); maximum size is 104857600 bytes",
      "invalid_argument",
    ],
    [
      "a file outside the roots",
      (path) => `${path} is outside WACLI_MEDIA_ROOTS; copy it into one of: /x`,
      "invalid_argument",
    ],
    [
      "a file that cannot be opened within the roots",
      () => "open media within WACLI_MEDIA_ROOTS: open 0123/photo.jpg: permission denied",
      "invalid_argument",
    ],
    [
      "a file that cannot be resolved",
      (path) => `resolve ${path}: lstat ${path}: no such file or directory`,
      "invalid_argument",
    ],
    ["a stat of a file that is gone", (path) => `stat ${path}: no such file or directory`, "invalid_argument"],
    ["an open of a file that is gone", (path) => `open ${path}: no such file or directory`, "invalid_argument"],
    [
      "a way of showing it wacli does not know",
      () => `invalid --as "x" (want auto|document|audio|image|video)`,
      "invalid_argument",
    ],
    ["an image that cannot be read", () => "invalid image data: image: unknown format", "invalid_argument"],
    ["an image without size", () => "invalid image dimensions: 0x0", "invalid_argument"],
    [
      "a media connection that cannot be had",
      () => "failed to refresh media connections: info query timed out",
      "upstream_error",
    ],
    ["an upload that was refused", () => "upload failed with status code 503", "upstream_error"],
    ["a file that cannot be encrypted", () => "failed to encrypt file: boom", "upstream_error"],
    [
      "a request dropped from the send queue",
      () => "request timed out in the send queue before dispatch; it was not sent",
      "upstream_error",
    ],
    [
      "a message to quote that is not stored",
      () => `quoted message ${REPLY_TO} not found in local store for chat ${CHAT}`,
      "not_found",
    ],
    [
      "a quote wacli cannot build",
      () => `cannot quote message ${REPLY_TO}: stored message was deleted`,
      "invalid_argument",
    ],
    ["a refused call", () => "read-only mode: send is refused", "invalid_argument"],
    ["no paired device", () => "not authenticated; run `wacli auth`", "unauthenticated"],
    ["a store held elsewhere", () => "store is locked (another wacli is running?): locked", "upstream_error"],
  ])("%s is %s, and nothing was sent", async (_what, text, code) => {
    fails(text(s.file))
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe(code)
    expect(error.message).not.toContain(s.fixture.paths.outbox)
  })

  test.each<[string, ErrorCode]>([
    ["error: file too large; maximum size is 1 bytes", "invalid_argument"],
    ["  error:  invalid image data: image: unknown format", "invalid_argument"],
    ["error: upload failed with status code 503", "upstream_error"],
  ])("%p is %s whether or not wacli opens it with error:", async (text, code) => {
    fails(text)
    expect((await asked()).code).toBe(code)
  })

  // wacli prints a path once it resolved the links on the way, such as a temporary folder reached through one.
  test("leaves the file's real path out of the message too", async () => {
    const real = realpathSync(s.file)
    fails(`resolve ${s.file}: lstat ${real}: no such file or directory`)
    const error = await asked()
    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain(real)
    expect(error.message).not.toContain(s.file)
  })
})

describe("what wacli says when the file may have gone out", () => {
  test.each([
    [
      "delegated file failed after dispatch and may still have gone through; check before retrying: context deadline exceeded",
    ],
    [
      "no reply from the running sync process before the timeout; the file may still have gone through, so check before retrying",
    ],
    ["no reply from the running sync process before the timeout"],
    ["invalid --as x; the file may still have gone through"],
    ["file too large; maximum size is 1 bytes; no reply from the running sync process"],
    ["failed to refresh media connections: x; the file may still have gone through"],
    ["upload failed with status code 500, and it may still have gone through"],
    ["send timed out after 45s"],
    ["send failed: file too large"],
    ["upload: failed to refresh media connections: x"],
    ["failed to upload file: failed to refresh media connections: x"],
    ["failed to send message: invalid image data"],
    ["not connected"],
    ["failed to send usync query; reconnect failed: not authenticated; run `wacli auth`"],
    ["connection lost; reconnect failed: dial tcp: i/o timeout"],
    ["something wacli has never said"],
    [""],
  ])("%p is uncertain", async (text) => {
    fails(text)
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("file")
  })

  test("does not take the file's path for the start of a text that only names another file", async () => {
    fails(`${join(s.fixture.paths.outbox, "0123", "other.jpg")} is not a regular file`)
    expect((await asked()).code).toBe("uncertain")
  })

  test("is uncertain when wacli exits 1 without a result, or ends on a signal", async () => {
    s.answerSend({ stderr: "panic: runtime error\n", exit: 1 })
    expect((await asked()).code).toBe("uncertain")
    s.answerSend({ stdout: "not json\n", exit: 2 })
    expect((await asked()).code).toBe("uncertain")
  })

  test.each([
    ["sent: false", { sent: false, to: CHAT, id: ID }],
    ["no sent", { to: CHAT, id: ID }],
    ["no id", { sent: true, to: CHAT }],
    ["an empty id", { sent: true, to: CHAT, id: "" }],
    ["no data", null],
  ])("is uncertain when wacli reports success with %s", async (_what, data) => {
    s.answerSend({ stdout: envelope(data) })
    const error = await asked()
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe("uncertain")
  })

  test("is uncertain when wacli exits 0 with output that is no result", async () => {
    s.answerSend({ stdout: "Sent photo.jpg to someone\n" })
    expect((await asked()).code).toBe("uncertain")
  })
})
