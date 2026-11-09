import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { ELF_BYTES } from "../../archive/archive.testing"
import { buildZip } from "../../archive/zip.testing"
import { wacliChat } from "../../chat/read.testing"
import { ToolError } from "../../errors"
import { createSandbox, fakeKey, type Sandbox } from "../../outgoing/outgoing.testing"
import { CHAT, createFileSendTest, type FileSendTest } from "./tool.testing"

let t: FileSendTest

beforeEach(async () => {
  t = await createFileSendTest()
})

afterEach(async () => {
  await t.close()
})

describe("arguments the tool refuses before it reads a file", () => {
  test.each([
    ["a name for a chat", { chat: "Ann" }],
    ["a number for a chat", { chat: "+15550100001" }],
    ["a reply_to that is not a message id", { reply_to: "../x" }],
    ["a text with a NUL", { text: "a\0b" }],
    ["a text with half a character", { text: "a\uD83D" }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["a broadcast list", { chat: "1555010000199@broadcast" }],
    ["the status feed", { chat: "status@broadcast" }],
  ])("refuses %s as invalid_argument, and makes no outbox", async (_name, change) => {
    await t.serve()
    t.box.write("notes.txt")
    const error = await t.failure({ chat: CHAT, files: [{ path: "notes.txt" }], text: "hi", ...change })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).not.toContain("15550100001")
    expect(await t.wacliCalls()).toEqual([])
    expect(existsSync(t.fixture.paths.outbox)).toBe(false)
  })

  test("says that sends go to people and groups only for a channel, a broadcast list and the status feed", async () => {
    for (const chat of ["120363000000000002@newsletter", "status@broadcast"]) {
      const error = await t.failure({ chat, files: [{ path: "notes.txt" }] })
      expect(error.message).toContain("people and groups only")
      expect(error.message).toContain("Nothing was sent")
    }
  })

  test("refuses a text over 1,024 characters counted as code points, saying its length and that it is never split", async () => {
    await t.serve()
    t.box.write("notes.txt")
    await t.run({ chat: CHAT, files: [{ path: "notes.txt" }], text: "😀".repeat(1024) })
    const error = await t.failure({ chat: CHAT, files: [{ path: "notes.txt" }], text: "😀".repeat(1025) })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("1025 characters")
    expect(error.message).toContain("never split")
    expect(error.message).toContain("whatsapp_message_send")
    expect(error.message).toContain("only if the user wants")
    expect(await t.sendCalls()).toHaveLength(1)
  })
})

describe("files the tool refuses, with nothing sent", () => {
  let elsewhere: Sandbox
  beforeEach(() => {
    elsewhere = createSandbox()
  })
  afterEach(() => elsewhere.remove())

  test.each([
    ["a file named like a secret", ".env", "KEY=value\n"],
    ["a private key", "notes.txt", fakeKey()],
    ["a program", "tool", ELF_BYTES],
    ["an archive holding a program", "bundle.zip", buildZip([{ name: "tool/readme.txt", data: ELF_BYTES }])],
    ["an empty file", "empty.txt", ""],
  ])("refuses %s as forbidden, after a good file that came before it", async (_what, name, content) => {
    await t.serve()
    t.box.write("good.txt")
    t.box.write(name, content)
    const error = await t.failure({ chat: CHAT, files: [{ path: "good.txt" }, { path: name }] })
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain(JSON.stringify(name))
    expect(await t.wacliCalls()).toEqual([])
    expect(t.outboxEntries()).toEqual([])
  })

  test("is stale for a file that is not the one the user approved, and nothing is sent", async () => {
    await t.serve()
    t.box.write("a.txt")
    t.box.write("b.txt")
    const error = await t.failure({ chat: CHAT, files: [{ path: "a.txt" }, { path: "b.txt", sha256: "0".repeat(64) }] })
    expect(error.code).toBe("stale")
    expect(await t.wacliCalls()).toEqual([])
    expect(t.outboxEntries()).toEqual([])
  })

  test("says to add the directory to send_dirs for a file outside the working directory, never to copy it", async () => {
    await t.serve()
    const outside = elsewhere.write("report.txt")
    const error = await t.failure({ chat: CHAT, files: [{ path: outside }] })
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("send_dirs")
    expect(await t.wacliCalls()).toEqual([])

    await t.run({ chat: CHAT, files: [{ path: outside }] }, { sendDirs: [elsewhere.root] })
    expect(await t.sentNames()).toEqual(["report.txt"])
  })
})

describe("the recipient", () => {
  const NEW_PERSON = "15550100009@s.whatsapp.net"
  const registered = { check: { "15550100009": { registered: true, jid: NEW_PERSON } } }

  test("is asked of WhatsApp right before the send when it is a person the mirror does not hold", async () => {
    await t.serve({ mirror: { ...registered, chats: [] } })
    t.box.write("notes.txt")
    expect((await t.run({ chat: NEW_PERSON, files: [{ path: "notes.txt" }] })).chat).toBe(NEW_PERSON)
    const calls = await t.wacliCalls()
    const check = calls.findIndex((call) => call.argv.includes("check"))
    const send = calls.findIndex((call) => call.argv.includes("send"))
    expect(check).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(check)
  })

  test("is not_found without an account, and nothing is sent or left in the outbox", async () => {
    await t.serve({ mirror: { chats: [], check: { "15550100009": { registered: false } } } })
    t.box.write("notes.txt")
    const error = await t.failure({ chat: NEW_PERSON, files: [{ path: "notes.txt" }] })
    expect(error.code).toBe("not_found")
    expect(await t.sendCalls()).toEqual([])
    expect(t.outboxEntries()).toEqual([])
  })

  test("is refused when the chat is not a person or a group", async () => {
    await t.serve({ mirror: { chats: [wacliChat({ jid: CHAT, kind: "broadcast" })] } })
    t.box.write("notes.txt")
    const error = await t.failure({ chat: CHAT, files: [{ path: "notes.txt" }] })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("people and groups only")
    expect(t.outboxEntries()).toEqual([])
  })

  test("is upstream_error without a running service, saying to start it and that nothing was sent", async () => {
    t.setUp()
    t.box.write("notes.txt")
    const error = await t.failure({ chat: CHAT, files: [{ path: "notes.txt" }] })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("is not running; start it first")
    expect(error.message).toContain("whatsapp_account_read")
    expect(error.message).toContain("Nothing was sent")
    expect(t.outboxEntries()).toEqual([])
  })

  test("is the abort itself when the call is aborted before it reaches the service, and nothing is sent", async () => {
    await t.serve()
    t.box.write("notes.txt")
    const controller = new AbortController()
    controller.abort()
    const error = await t
      .failure({ chat: CHAT, files: [{ path: "notes.txt" }] }, controller.signal)
      .catch((thrown: unknown) => thrown)
    expect(error).not.toBeInstanceOf(ToolError)
    expect(await t.sendCalls()).toEqual([])
    expect(t.outboxEntries()).toEqual([])
  })
})
