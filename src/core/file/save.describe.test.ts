import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { ALICE, TEAM, at, wacliChat, wacliMessage } from "../chat/read.testing"
import { callDescription } from "../describe"
import { translator } from "../words"
import { createFileSave } from "./save"
import { MESSAGE_ID, createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"
import { FILE_SAVE_TRANSLATIONS, FILE_SAVE_WORDS } from "./words"

let t: SaveFixture

beforeEach(async () => {
  t = await createSaveFixture()
})
afterEach(() => t.close())

const describeCall = (args: Record<string, unknown>) =>
  callDescription(createFileSave(), args, { cwd: t.stateDir, stateDir: t.stateDir, downloadDir: t.downloadDir })

const GROUP_ID = "3EB0GROUPIMAGE01"

/** The mirror: Alice's chat with a document of hers and one of the user's, and the team group with an image. */
function setMirror(media: Record<string, unknown> = {}): void {
  t.fake.setMirror({
    chats: [wacliChat({ jid: ALICE, name: "Alice" }), wacliChat({ jid: TEAM, kind: "group", name: "Team" })],
    messages: [
      wacliMessage({
        id: MESSAGE_ID,
        chat: ALICE,
        at: at(1),
        MediaType: "document",
        Filename: "notes.txt",
        MimeType: "text/plain",
        ...media,
      }),
      wacliMessage({
        id: GROUP_ID,
        chat: TEAM,
        at: at(2),
        MediaType: "image",
        Filename: "photo.jpg",
        MimeType: "image/jpeg",
        SenderName: "Bob B",
      }),
      wacliMessage({ id: "3EB0PLAINTEXT0001", chat: ALICE, at: at(3), Text: "hello" }),
    ],
  })
}

describe("the description of a file save", () => {
  test("tells an image from a named sender in a named group", async () => {
    setMirror()
    expect(await describeCall({ chat: TEAM, id: GROUP_ID })).toEqual({
      headline: { text: FILE_SAVE_WORDS.headline, values: { file: "photo.jpg", chat: "Team" } },
      facts: [
        { label: FILE_SAVE_WORDS.kindLabel, value: { text: FILE_SAVE_WORDS.image } },
        { label: FILE_SAVE_WORDS.fromLabel, value: "Bob B" },
      ],
    })
  })

  test("tells a document the user sent as From You, with the cleaned file name", async () => {
    setMirror({ FromMe: true, Filename: "../../my notes.txt" })
    const description = await describeCall(saveArgs())
    expect(description?.headline?.values).toEqual({ file: "_.._.._my notes.txt", chat: "Alice" })
    expect(description?.facts).toEqual([
      { label: FILE_SAVE_WORDS.kindLabel, value: { text: FILE_SAVE_WORDS.document } },
      { label: FILE_SAVE_WORDS.fromLabel, value: { text: FILE_SAVE_WORDS.you } },
    ])
  })

  test("names a sender with no mirror name by the number", async () => {
    setMirror()
    expect((await describeCall(saveArgs()))?.facts[1]?.value).toBe("+15550100001")
  })

  test("uses the fallback name of a message with no file name, as the save does", async () => {
    setMirror({ Filename: "" })
    const described = (await describeCall(saveArgs()))?.headline?.values?.file
    t.respond({ args: ["media", "download"], writeOutput: { text: "x" } })
    const saved = await t.save(saveArgs())
    expect(described).toBeTruthy()
    expect(saved.file?.name).toBe(described as string)
  })

  test("adds the Unpack fact only when asked", async () => {
    setMirror()
    expect((await describeCall(saveArgs()))?.facts).toHaveLength(2)
    expect((await describeCall(saveArgs({ unpack: false })))?.facts).toHaveLength(2)
    expect((await describeCall(saveArgs({ unpack: true })))?.facts[2]).toEqual({
      label: FILE_SAVE_WORDS.unpackLabel,
      value: { text: FILE_SAVE_WORDS.unpack },
    })
  })

  test("leaves the Unpack fact out for a file that is not a document, which is never an archive", async () => {
    setMirror()
    const args = { ...saveArgs({ unpack: true }), chat: TEAM, id: GROUP_ID }
    expect((await describeCall(args))?.facts.map(({ label }) => label)).toEqual([
      FILE_SAVE_WORDS.kindLabel,
      FILE_SAVE_WORDS.fromLabel,
    ])
  })

  test("shows an unknown wacli kind as plain data", async () => {
    setMirror({ MediaType: "ptv" })
    expect((await describeCall(saveArgs()))?.facts[0]).toEqual({ label: FILE_SAVE_WORDS.kindLabel, value: "ptv" })
  })

  test("matches a known kind whatever its case", async () => {
    setMirror({ MediaType: "Video" })
    expect((await describeCall(saveArgs()))?.facts[0]?.value).toEqual({ text: FILE_SAVE_WORDS.video })
  })

  test.each([
    ["a chat not in the mirror", { chat: "15550100077@s.whatsapp.net", id: MESSAGE_ID }],
    ["a message without a file", { chat: ALICE, id: "3EB0PLAINTEXT0001" }],
    ["a message not in the chat", { chat: ALICE, id: "NOSUCHMESSAGE" }],
    ["a bad id", { chat: ALICE, id: "../etc" }],
    ["a name instead of a JID", { chat: "Alice", id: MESSAGE_ID }],
  ])("gives no description for %s", async (_what, args) => {
    setMirror()
    expect(await describeCall(args)).toBeUndefined()
  })

  test("only reads: every wacli call carries --read-only and the download directory stays empty", async () => {
    setMirror()
    await describeCall(saveArgs({ unpack: true }))
    const calls = (await t.fake.calls()).filter((call) => call.argv[0] !== "version")
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.argv).toContain("--read-only")
    expect(readdirSync(t.downloadDir)).toEqual([])
  })

  test("has a Japanese headline", async () => {
    setMirror()
    const description = await describeCall(saveArgs())
    expect(translator(FILE_SAVE_TRANSLATIONS, "ja").template(description!.headline!.text)).toBe(
      "{chat} の {file} を保存しようとしています",
    )
  })
})
