import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ALICE, TEAM, at, wacliChat, wacliMessage } from "../../chat/read.testing"
import { callDescription } from "../../describe"
import { MESSAGE_WORDS } from "../../message/words"
import { pinOf } from "../../pin"
import { translator } from "../../words"
import { JPEG, MP3, REPLY_ID, createFileSendTest, type FileSendTest } from "./tool.testing"
import { createFileSend } from "./tool"
import { FILE_SEND_TRANSLATIONS, FILE_SEND_WORDS } from "./words"

let t: FileSendTest

const MP4 = Buffer.from("\0\0\0\u0018ftypisom\0\0\0\0", "latin1")
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const sizeValue = (bytes: number) => ({ text: bytes === 1 ? "{bytes} byte" : "{bytes} bytes", values: { bytes } })

const MIRROR = {
  chats: [wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: TEAM, kind: "group", name: "Team" })],
  messages: [wacliMessage({ id: REPLY_ID, chat: ALICE, at: at(1), SenderName: "Alice A" })],
}

beforeEach(async () => {
  t = await createFileSendTest()
  t.setUp({ mirror: MIRROR })
})

afterEach(async () => {
  await t.close()
})

const tool = createFileSend()
const describeCall = (args: Record<string, unknown>) =>
  callDescription(tool, { chat: ALICE, ...args }, { cwd: t.box.root, stateDir: t.fixture.stateDir })

describe("the description of a file send", () => {
  test("tells one photo to a named person, and pins its SHA-256", async () => {
    t.box.write("holiday.jpg", JPEG)
    expect(await describeCall({ files: [{ path: "holiday.jpg" }] })).toEqual({
      headline: { text: FILE_SEND_WORDS.headlineOne, values: { file: "holiday.jpg", chat: "Alice" } },
      facts: [
        { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.person } },
        { label: FILE_SEND_WORDS.sentAsLabel, value: { text: FILE_SEND_WORDS.photo } },
        { label: "Size", value: sizeValue(JPEG.length) },
      ],
      pins: { "sha256:0": sha256(JPEG) },
    })
  })

  test("tells a count per kind in the order photos, videos, audio, documents, and the total size", async () => {
    t.box.write("a.jpg", JPEG)
    t.box.write("b.jpg", Buffer.concat([JPEG, Buffer.from("b")]))
    t.box.write("notes.txt", "hello\n")
    t.box.write("clip.mp4", MP4)
    t.box.write("song.mp3", MP3)
    const files = ["notes.txt", "song.mp3", "clip.mp4", "a.jpg", "b.jpg"].map((path) => ({ path }))
    const description = await describeCall({ chat: TEAM, files })
    expect(description?.headline).toEqual({
      text: FILE_SEND_WORDS.headlineSeveral,
      values: { chat: "Team" },
    })
    expect(description?.facts).toEqual([
      { label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.group } },
      { label: FILE_SEND_WORDS.photos, value: "2" },
      { label: FILE_SEND_WORDS.videos, value: "1" },
      { label: FILE_SEND_WORDS.audioFiles, value: "1" },
      { label: FILE_SEND_WORDS.documents, value: "1" },
      { label: "Size", value: sizeValue(6 + MP4.length + MP3.length + JPEG.length * 2 + 1) },
    ])
    expect(Object.keys(description!.pins!)).toEqual(["sha256:0", "sha256:1", "sha256:2", "sha256:3", "sha256:4"])
    expect(description!.pins!["sha256:3"]).toBe(sha256(JPEG))
  })

  test("tells a single audio file and a single video by their kind", async () => {
    t.box.write("song.mp3", MP3)
    t.box.write("clip.mp4", MP4)
    expect((await describeCall({ files: [{ path: "song.mp3" }] }))?.facts[1]?.value).toEqual({
      text: FILE_SEND_WORDS.audio,
    })
    expect((await describeCall({ files: [{ path: "clip.mp4" }] }))?.facts[1]?.value).toEqual({
      text: FILE_SEND_WORDS.video,
    })
  })

  test("tells a document for any file asked to go as one", async () => {
    t.box.write("holiday.jpg", JPEG)
    const description = await describeCall({ files: [{ path: "holiday.jpg" }], as_document: true })
    expect(description?.facts[1]).toEqual({
      label: FILE_SEND_WORDS.sentAsLabel,
      value: { text: FILE_SEND_WORDS.document },
    })
  })

  test("tells a file whose bytes are not its name's kind as a document", async () => {
    t.box.write("fake.jpg", "not a photo\n")
    expect((await describeCall({ files: [{ path: "fake.jpg" }] }))?.facts[1]?.value).toEqual({
      text: FILE_SEND_WORDS.document,
    })
  })

  test("shows the trimmed caption as the text", async () => {
    t.box.write("holiday.jpg", JPEG)
    const description = await describeCall({ files: [{ path: "holiday.jpg" }], text: "  Look!\n " })
    expect(description?.text).toEqual({ label: FILE_SEND_WORDS.textLabel, body: "Look!" })
    expect(await describeCall({ files: [{ path: "holiday.jpg" }], text: "  " })).not.toHaveProperty("text")
  })

  test("gives no description for a caption on an audio first file, but allows one on a later audio file", async () => {
    t.box.write("song.mp3", MP3)
    t.box.write("holiday.jpg", JPEG)
    expect(await describeCall({ files: [{ path: "song.mp3" }], text: "hi" })).toBeUndefined()
    const later = await describeCall({ files: [{ path: "holiday.jpg" }, { path: "song.mp3" }], text: "hi" })
    expect(later?.text?.body).toBe("hi")
  })

  test("tells whom a reply quotes, after the chat", async () => {
    t.box.write("holiday.jpg", JPEG)
    const description = await describeCall({ files: [{ path: "holiday.jpg" }], reply_to: REPLY_ID })
    expect(description?.facts.map(({ label }) => label)).toEqual([
      MESSAGE_WORDS.chatLabel,
      MESSAGE_WORDS.replyLabel,
      FILE_SEND_WORDS.sentAsLabel,
      "Size",
    ])
  })

  test.each([
    ["a reply to a message not in the chat", { reply_to: "NOSUCHMESSAGE" }],
    ["a reply from a new person", { chat: "15550100009@s.whatsapp.net", reply_to: REPLY_ID }],
    ["a channel", { chat: "120363000000000002@newsletter" }],
    ["a caption over the limit", { text: "x".repeat(1025) }],
  ])("gives no description for %s", async (_what, change) => {
    t.box.write("holiday.jpg", JPEG)
    expect(await describeCall({ files: [{ path: "holiday.jpg" }], ...change })).toBeUndefined()
  })

  test("tells a new person by the number, without asking WhatsApp", async () => {
    t.box.write("holiday.jpg", JPEG)
    const description = await describeCall({ chat: "15550100009@s.whatsapp.net", files: [{ path: "holiday.jpg" }] })
    expect(description?.headline?.values).toEqual({ file: "holiday.jpg", chat: "+15550100009" })
    expect(description?.facts[0]).toEqual({ label: MESSAGE_WORDS.chatLabel, value: { text: MESSAGE_WORDS.newPerson } })
  })

  test("only reads: every wacli call carries --read-only, and no outbox is made", async () => {
    t.box.write("holiday.jpg", JPEG)
    await describeCall({ files: [{ path: "holiday.jpg" }], reply_to: REPLY_ID })
    await describeCall({ chat: "15550100009@s.whatsapp.net", files: [{ path: "holiday.jpg" }] })
    const calls = await t.wacliCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.argv).toContain("--read-only")
    expect(await t.sendCalls()).toEqual([])
    expect(t.outboxEntries()).toEqual([])
  })

  test("has Japanese headlines that keep their placeholders", () => {
    const ja = translator(FILE_SEND_TRANSLATIONS, "ja")
    expect(ja.template(FILE_SEND_WORDS.headlineOne)).toBe("{chat} に {file} を送ろうとしています")
    expect(ja.template(FILE_SEND_WORDS.headlineSeveral)).toBe("{chat} にファイルを送ろうとしています")
    expect(ja.template(FILE_SEND_WORDS.photos)).toBe("写真")
  })
})

describe("what a file send pins", () => {
  test("changes with a file's bytes though its size stays the same", async () => {
    const path = t.box.write("notes.txt", "version one\n")
    const first = await describeCall({ files: [{ path: "notes.txt" }] })
    t.box.write("notes.txt", "version two\n")
    const second = await describeCall({ files: [{ path: "notes.txt" }] })
    expect(second?.facts).toEqual(first!.facts)
    expect(second?.pins).not.toEqual(first!.pins)
    expect(pinOf([path], second!)).not.toBe(pinOf([path], first!))
  })

  test("gives the same answer for the same state", async () => {
    t.box.write("holiday.jpg", JPEG)
    const args = { files: [{ path: "holiday.jpg" }], text: "Look!", reply_to: REPLY_ID }
    expect(await describeCall(args)).toEqual(await describeCall(args))
  })
})
