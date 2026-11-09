import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import {
  CHAT,
  JPEG,
  MP3,
  REPLY_ID,
  SENT_ID,
  flagOf,
  createFileSendTest,
  sentResponse,
  type FileSendTest,
} from "./tool.testing"

let t: FileSendTest

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

beforeEach(async () => {
  t = await createFileSendTest()
})

afterEach(async () => {
  await t.close()
})

describe("a photo with a caption", () => {
  test("is accepted, and the result names the message, the file as it was sent and what accepted means", async () => {
    await t.serve()
    const real = t.box.write("holiday.jpg", JPEG)
    const before = Date.now()
    const result = await t.run({ chat: CHAT, files: [{ path: "holiday.jpg" }], text: "  Look!\n " })
    expect(result).toEqual({
      chat: CHAT,
      messages: [{ name: "holiday.jpg", id: SENT_ID, time: expect.stringMatching(LOCAL_TIME), as: "image" }],
      files: [{ path: real, name: "holiday.jpg", size: JPEG.length, sha256: sha256(JPEG) }],
      note: result.note,
    })
    expect(Date.parse(result.messages[0]!.time)).toBeGreaterThanOrEqual(before)
    expect(result.note).toContain("not delivered or read")
    expect(result.note).toContain("its own message")
    expect(result).not.toHaveProperty("errors")
  })

  test("goes to wacli as a copy in the outbox, named, shown as an image, typed and captioned, and the copy is removed", async () => {
    await t.serve()
    t.box.write("holiday.jpg", JPEG)
    await t.run({ chat: CHAT, files: [{ path: "holiday.jpg" }], text: "  Look!\n " })
    const [call, ...others] = await t.sendCalls()
    expect(others).toEqual([])
    const sent = flagOf(call!, "--file")!
    expect(sent.startsWith(`${t.fixture.paths.outbox}/`)).toBe(true)
    expect(sent.endsWith("/holiday.jpg")).toBe(true)
    expect(flagOf(call!, "--to")).toBe(CHAT)
    expect(flagOf(call!, "--filename")).toBe("holiday.jpg")
    expect(flagOf(call!, "--as")).toBe("image")
    expect(flagOf(call!, "--mime")).toBe("image/jpeg")
    expect(flagOf(call!, "--caption")).toBe("Look!")
    expect(call!.argv).not.toContain("--reply-to")
    expect(call!.argv).not.toContain("--read-only")
    expect(existsSync(sent)).toBe(false)
    expect(t.outboxEntries()).toEqual([])
  })

  test("is given nearly the whole budget, less what the service is given beyond it and what wacli keeps back", async () => {
    await t.serve()
    t.box.write("holiday.jpg", JPEG)
    await t.run({ chat: CHAT, files: [{ path: "holiday.jpg" }] })
    const [call] = await t.sendCalls()
    const seconds = Number.parseInt(flagOf(call!, "--timeout")!, 10)
    expect(seconds).toBeGreaterThanOrEqual(250)
    expect(seconds).toBeLessThanOrEqual(255)
  })

  test("is shown the way wacli says WhatsApp showed it", async () => {
    await t.serve({ files: { "holiday.jpg": sentResponse(SENT_ID, { file: { media: "document" } }) } })
    t.box.write("holiday.jpg", JPEG)
    const result = await t.run({ chat: CHAT, files: [{ path: "holiday.jpg" }] })
    expect(result.messages[0]!.as).toBe("document")
  })

  test("takes the file's digest when it is the one the user approved, in either case", async () => {
    await t.serve()
    t.box.write("holiday.jpg", JPEG)
    const digest = sha256(JPEG)
    for (const approved of [digest, digest.toUpperCase()]) {
      await t.run({ chat: CHAT, files: [{ path: "holiday.jpg", sha256: approved }] })
    }
    expect(await t.sendCalls()).toHaveLength(2)
  })
})

describe("how a file is shown", () => {
  const flags = async () => {
    const [call] = await t.sendCalls()
    return { as: flagOf(call!, "--as"), mime: flagOf(call!, "--mime"), caption: flagOf(call!, "--caption") }
  }

  test("is a document with its type for a file WhatsApp does not show itself, and no caption without a text", async () => {
    await t.serve()
    t.box.write("notes.txt")
    await t.run({ chat: CHAT, files: [{ path: "notes.txt" }], text: " \n " })
    expect(await flags()).toEqual({ as: "document", mime: "text/plain", caption: undefined })
  })

  test("is audio for an MP3, and a document with as_document, which keeps its type", async () => {
    await t.serve()
    t.box.write("song.mp3", MP3)
    await t.run({ chat: CHAT, files: [{ path: "song.mp3" }] })
    expect(await flags()).toMatchObject({ as: "audio", mime: "audio/mpeg" })
    await t.run({ chat: CHAT, files: [{ path: "song.mp3" }], as_document: true, text: "for the record" })
    expect((await t.sendCalls()).map((call) => flagOf(call, "--as"))).toEqual(["audio", "document"])
  })

  test("is a document when the bytes do not say what the name does", async () => {
    await t.serve()
    t.box.write("photo.jpg", "not a photo at all\n")
    await t.run({ chat: CHAT, files: [{ path: "photo.jpg" }] })
    expect(await flags()).toMatchObject({ as: "document", mime: "application/octet-stream" })
  })

  test("is refused for a caption on an audio first file, with nothing sent and nothing left in the outbox", async () => {
    await t.serve()
    t.box.write("song.mp3", MP3)
    const error = await t.failure({ chat: CHAT, files: [{ path: "song.mp3" }], text: "hi" })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("audio")
    expect(error.message).toContain("as_document")
    expect(await t.wacliCalls()).toEqual([])
    expect(t.outboxEntries()).toEqual([])
  })

  test("takes a caption on a photo that comes before audio, which goes without one", async () => {
    await t.serve()
    t.box.write("photo.jpg", JPEG)
    t.box.write("song.mp3", MP3)
    await t.run({ chat: CHAT, files: [{ path: "photo.jpg" }, { path: "song.mp3" }], text: "hi" })
    expect((await t.sendCalls()).map((call) => flagOf(call, "--caption"))).toEqual(["hi", undefined])
  })

  test("is quoted to the message reply_to names, which the mirror holds", async () => {
    await t.serve()
    t.box.write("notes.txt")
    await t.run({ chat: CHAT, files: [{ path: "notes.txt" }], reply_to: REPLY_ID })
    const [call] = await t.sendCalls()
    expect(flagOf(call!, "--reply-to")).toBe(REPLY_ID)
    expect((await t.failure({ chat: CHAT, files: [{ path: "notes.txt" }], reply_to: "3EB0000000000000" })).code).toBe(
      "not_found",
    )
  })
})
