import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failure } from "../../whatsapp/wacli.testing"
import { CHAT, JPEG, REPLY_ID, createFileSendTest, flagOf, sentResponse, type FileSendTest } from "./tool.testing"

let t: FileSendTest

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/

/** A wacli that fails with `text` for the file sent under a name. */
const fails = (text: string) => ({ stderr: failure(text), exit: 1 })

beforeEach(async () => {
  t = await createFileSendTest()
})

afterEach(async () => {
  await t.close()
})

/** Makes the three files of most tests: two photos and a document, in the order a send names them. */
function makeThree() {
  t.box.write("a.jpg", JPEG)
  t.box.write("b.jpg", JPEG)
  t.box.write("c.txt")
  return { chat: CHAT, files: [{ path: "a.jpg" }, { path: "b.jpg" }, { path: "c.txt" }] }
}

describe("several files", () => {
  test("go as one message each, in the order given, with the caption and the quote on the first only", async () => {
    await t.serve({
      files: { "a.jpg": sentResponse("ID1"), "b.jpg": sentResponse("ID2"), "c.txt": sentResponse("ID3") },
    })
    const result = await t.run({ ...makeThree(), text: "Holiday", reply_to: REPLY_ID })
    expect(await t.sentNames()).toEqual(["a.jpg", "b.jpg", "c.txt"])
    const calls = await t.sendCalls()
    expect(calls.map((call) => flagOf(call, "--caption"))).toEqual(["Holiday", undefined, undefined])
    expect(calls.map((call) => flagOf(call, "--reply-to"))).toEqual([REPLY_ID, undefined, undefined])
    expect(calls.map((call) => flagOf(call, "--as"))).toEqual(["image", "image", "document"])
    expect(result.messages).toEqual([
      { name: "a.jpg", id: "ID1", time: expect.stringMatching(LOCAL_TIME), as: "image" },
      { name: "b.jpg", id: "ID2", time: expect.stringMatching(LOCAL_TIME), as: "image" },
      { name: "c.txt", id: "ID3", time: expect.stringMatching(LOCAL_TIME), as: "document" },
    ])
    expect(result.files.map((file) => file.name)).toEqual(["a.jpg", "b.jpg", "c.txt"])
    expect(result).not.toHaveProperty("errors")
    expect(t.outboxEntries()).toEqual([])
  })

  test("are each given the time that is left, so that the call ends within its budget", async () => {
    await t.serve({ files: { "a.jpg": { ...sentResponse("ID1"), sleepMs: 1500 } } })
    await t.run(makeThree())
    const seconds = (await t.sendCalls()).map((call) => Number.parseInt(flagOf(call, "--timeout")!, 10))
    expect(seconds[0]! - seconds[1]!).toBeGreaterThanOrEqual(1)
    // Files 2 and 3 go one right after the other; a busy machine may still take a second or two between them.
    expect(seconds[1]! - seconds[2]!).toBeLessThanOrEqual(3)
  })

  test("say which files could not be written to the mirror, and are still the result", async () => {
    await t.serve({ files: { "b.jpg": sentResponse("ID2", { store_warning: "message update: disk full" }) } })
    const result = await t.run(makeThree())
    expect(result.messages).toHaveLength(3)
    expect(result.errors).toEqual({ record: "b.jpg: message update: disk full" })
  })

  test("are never sent when one of them is refused, and the outbox is left empty", async () => {
    await t.serve()
    t.box.write("a.jpg", JPEG)
    t.box.write(".env", "KEY=value\n")
    const error = await t.failure({ chat: CHAT, files: [{ path: "a.jpg" }, { path: ".env" }] })
    expect(error.code).toBe("forbidden")
    expect(await t.wacliCalls()).toEqual([])
    expect(t.outboxEntries()).toEqual([])
  })
})

describe("a send that stops part-way", () => {
  test("stops at the first file wacli says it did not send, with that file's code, and lists what went out", async () => {
    await t.serve({
      files: {
        "a.jpg": sentResponse("ID1"),
        "b.jpg": fails("invalid image data: image: unknown format"),
      },
    })
    const error = await t.failure(makeThree())
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toStartWith(
      '1 of 3 files went out before "b.jpg" (it was not sent, and the files after it were not tried).',
    )
    expect(error.message).toContain("invalid image data")
    expect(error.message).toContain("Never send the files that went out again")
    expect(error.message).toContain("whatsapp_chat_read")
    expect(error.message).toContain("ask the user before sending anything again")
    expect(error.details).toEqual({
      sent: [{ name: "a.jpg", id: "ID1", time: expect.stringMatching(LOCAL_TIME), as: "image" }],
      stopped: { name: "b.jpg", code: "invalid_argument" },
      not_sent: ["c.txt"],
    })
    expect(await t.sentNames()).toEqual(["a.jpg", "b.jpg"])
    expect(t.outboxEntries()).toEqual([])
  })

  test("is uncertain when the second file may have gone out, and says so, with the third never tried", async () => {
    await t.serve({ files: { "a.jpg": sentResponse("ID1"), "b.jpg": fails("send timed out after 45s") } })
    const error = await t.failure(makeThree())
    expect(error.code).toBe("uncertain")
    expect(error.message).toStartWith(
      '1 of 3 files went out before "b.jpg" (it may have gone out too, and the files after it were not tried).',
    )
    expect(error.message).toContain("may have been sent")
    expect(error.message).toContain("never send them again on your own")
    expect(error.details).toMatchObject({
      sent: [{ name: "a.jpg", id: "ID1" }],
      stopped: { name: "b.jpg", code: "uncertain" },
      not_sent: ["c.txt"],
    })
    expect(await t.sentNames()).toEqual(["a.jpg", "b.jpg"])
    expect(t.outboxEntries()).toEqual([])
  })

  test("is uncertain when the first of several may have gone out, and no other is sent", async () => {
    await t.serve({ files: { "a.jpg": fails("send timed out after 45s") } })
    const error = await t.failure(makeThree())
    expect(error.code).toBe("uncertain")
    expect(error.message).toStartWith(
      '"a.jpg", the first of 3 files, may have gone out, and the files after it were not sent.',
    )
    expect(error.message).toContain("ask the user before sending anything again")
    expect(error.details).toEqual({
      sent: [],
      stopped: { name: "a.jpg", code: "uncertain" },
      not_sent: ["b.jpg", "c.txt"],
    })
    expect(await t.sentNames()).toEqual(["a.jpg"])
    expect(t.outboxEntries()).toEqual([])
  })

  test("says that none went out when the first of several was not sent", async () => {
    await t.serve({ files: { "a.jpg": fails("upload failed with status code 503") } })
    const error = await t.failure(makeThree())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toStartWith(
      'None of the 3 files went out ("a.jpg" was not sent, and the files after it were not tried).',
    )
    expect(error.message).not.toContain("Never send")
    expect(error.details).toMatchObject({ sent: [], stopped: { name: "a.jpg", code: "upstream_error" } })
    expect(await t.sentNames()).toEqual(["a.jpg"])
  })

  test("fails as a send of one file does when only one was named, with no details", async () => {
    await t.serve({ files: { "a.jpg": fails("send timed out after 45s") } })
    makeThree()
    const error = await t.failure({ chat: CHAT, files: [{ path: "a.jpg" }] })
    expect(error.code).toBe("uncertain")
    expect(error.message).toStartWith("The file may have been sent.")
    expect(error.details).toBeUndefined()
  })

  test("is uncertain with what went out listed when the call is cancelled while the second is in flight", async () => {
    await t.serve({ files: { "a.jpg": sentResponse("ID1"), "b.jpg": { hang: true } } })
    const controller = new AbortController()
    const pending = t.failure(makeThree(), controller.signal)
    await t.sentOnce(2)
    controller.abort()
    const error = await pending
    expect(error.code).toBe("uncertain")
    expect(error.message).toStartWith('1 of 3 files went out before "b.jpg" (it may have gone out too')
    expect(error.details).toMatchObject({ sent: [{ id: "ID1" }], stopped: { name: "b.jpg" }, not_sent: ["c.txt"] })
    expect(await t.sentNames()).toEqual(["a.jpg", "b.jpg"])
    expect(t.outboxEntries()).toEqual([])
  })

  test("is uncertain when the first of several is in flight and the call is cancelled, with no other sent", async () => {
    await t.serve({ files: { "a.jpg": { hang: true } } })
    const controller = new AbortController()
    const pending = t.failure(makeThree(), controller.signal)
    await t.sentOnce(1)
    controller.abort()
    const error = await pending
    expect(error.code).toBe("uncertain")
    expect(error.details).toMatchObject({ sent: [], stopped: { name: "a.jpg", code: "uncertain" } })
    expect(await t.sentNames()).toEqual(["a.jpg"])
  })

  test("stops at a file for which the call's time has run out, as not sent, and does not run it", async () => {
    await t.serve({
      files: { "a.jpg": { ...sentResponse("ID1"), sleepMs: 7000 } },
      timing: { budgetMs: 20_000, minFileMs: 12_000, marginMs: 2000 },
    })
    const error = await t.failure(makeThree())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toStartWith('1 of 3 files went out before "b.jpg" (it was not sent')
    expect(error.message).toContain("no time left to send")
    expect(error.message).toContain("nothing of it was sent")
    expect(error.details).toMatchObject({
      sent: [{ name: "a.jpg", id: "ID1" }],
      stopped: { name: "b.jpg", code: "upstream_error" },
      not_sent: ["c.txt"],
    })
    expect(await t.sentNames()).toEqual(["a.jpg"])
    expect(t.outboxEntries()).toEqual([])
  }, 30_000)

  test("is upstream_error without a running service, and nothing is sent", async () => {
    t.setUp()
    const error = await t.failure(makeThree())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toStartWith('None of the 3 files went out ("a.jpg" was not sent')
    expect(error.message).toContain("is not running; start it first")
    expect(await t.sendCalls()).toEqual([])
    expect(t.outboxEntries()).toEqual([])
  })
})
