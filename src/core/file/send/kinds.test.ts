import { describe, expect, test } from "bun:test"
import { kindOf } from "./kinds"

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00")
const MP3_FRAME = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0])
const ADTS = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f])
const AMR = Buffer.from("#!AMR\n\x3c")

/** The first bytes of an ISO base media file whose first brand is `brand`. */
const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}\0\0\0\0isom`)])

/** The first bytes of an Ogg file whose first page holds `packet`, after a segment table of `segments` entries. */
function ogg(packet: string, segments = 1): Buffer {
  const header = Buffer.alloc(27 + segments)
  header.write("OggS", 0, "latin1")
  header[26] = segments
  return Buffer.concat([header, Buffer.from(packet, "latin1"), Buffer.alloc(32)])
}

describe("a file named and made as a photo", () => {
  test.each([
    ["photo.jpg", JPEG, "image/jpeg"],
    ["PHOTO.JPEG", JPEG, "image/jpeg"],
    ["shot.png", PNG, "image/png"],
    ["loop.gif", GIF, "image/gif"],
    ["loop.gif", Buffer.from("GIF87a\0\0"), "image/gif"],
  ])("%s is an image of type %s", (name, head, mime) => {
    expect(kindOf(name, head)).toEqual({ as: "image", mime })
  })
})

describe("a file named and made as a video", () => {
  test.each([
    ["clip.mp4", "isom", "video/mp4"],
    ["clip.mp4", "mp42", "video/mp4"],
    ["clip.mp4", "avc1", "video/mp4"],
    ["clip.m4v", "M4V ", "video/mp4"],
    ["clip.3gp", "3gp4", "video/3gpp"],
    ["clip.3gp", "3gp5", "video/3gpp"],
  ])("%s with the brand %s is a video of type %s", (name, brand, mime) => {
    expect(kindOf(name, ftyp(brand))).toEqual({ as: "video", mime })
  })

  test("a QuickTime movie goes as a document, since WhatsApp does not take it as a video", () => {
    expect(kindOf("clip.mov", ftyp("qt  "))).toEqual({ as: "document", mime: "video/quicktime" })
  })
})

describe("a file named and made as audio", () => {
  test.each([
    ["song.mp3", Buffer.from("ID3\x04\0\0\0\0\0\0"), "audio/mpeg"],
    ["song.mp3", MP3_FRAME, "audio/mpeg"],
    ["memo.m4a", ftyp("M4A "), "audio/mp4"],
    ["memo.aac", ADTS, "audio/aac"],
    ["memo.aac", Buffer.from([0xff, 0xf9, 0x50, 0x80]), "audio/aac"],
    ["voice.ogg", ogg("OpusHead\x01\x02"), "audio/ogg"],
    ["voice.opus", ogg("OpusHead\x01\x02"), "audio/ogg"],
    ["voice.oga", ogg("OpusHead", 3), "audio/ogg"],
    ["call.amr", AMR, "audio/amr"],
  ])("%s is audio of type %s", (name, head, mime) => {
    expect(kindOf(name, head)).toEqual({ as: "audio", mime })
  })
})

describe("a file whose bytes do not match its name", () => {
  test.each([
    ["a PNG named .jpg", "photo.jpg", PNG],
    ["a JPEG named .png", "photo.png", JPEG],
    ["text named .gif", "loop.gif", Buffer.from("not a gif at all")],
    ["text named .mp4", "clip.mp4", Buffer.from("not a movie at all")],
    ["an MP4 named .3gp", "clip.3gp", ftyp("isom")],
    ["a 3GP named .mp4", "clip.mp4", ftyp("3gp4")],
    ["a QuickTime file named .mp4", "clip.mp4", ftyp("qt  ")],
    ["an M4A named .mp4", "clip.mp4", ftyp("M4A ")],
    ["an MP4 named .m4a", "memo.m4a", ftyp("isom")],
    ["an AAC stream named .mp3", "song.mp3", ADTS],
    ["an MP3 named .aac", "memo.aac", MP3_FRAME],
    ["a frame with no layer named .mp3", "song.mp3", Buffer.from([0xff, 0xf9, 0x50, 0x80])],
    ["a frame with a bitrate no MP3 has named .mp3", "song.mp3", Buffer.from([0xff, 0xfb, 0xf0, 0x64])],
    ["an empty file named .jpg", "photo.jpg", Buffer.alloc(0)],
    ["a file shorter than its signature", "shot.png", PNG.subarray(0, 4)],
    ["a JPEG with no extension", "photo", JPEG],
  ])("%s is a document with no type of its own", (_what, name, head) => {
    expect(kindOf(name, head)).toEqual({ as: "document", mime: "application/octet-stream" })
  })

  test("an Ogg file that does not hold Opus goes as a document, since wacli would label it Opus", () => {
    for (const head of [ogg("\x01vorbis"), ogg("fLaC"), ogg("OpusHead", 1).subarray(0, 30), ogg("xOpusHead", 1)]) {
      expect(kindOf("voice.ogg", head)).toEqual({ as: "document", mime: "application/octet-stream" })
    }
    expect(kindOf("voice.ogg", ogg("OpusHead", 255).subarray(0, 100))).toEqual({
      as: "document",
      mime: "application/octet-stream",
    })
  })
})

describe("every other file", () => {
  test.each([
    ["report.pdf", "application/pdf"],
    ["Notes.TXT", "text/plain"],
    ["data.csv", "text/csv"],
    ["data.json", "application/json"],
    ["bundle.zip", "application/zip"],
    ["bundle.tar", "application/x-tar"],
    ["bundle.tgz", "application/gzip"],
    ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["letter.odt", "application/vnd.oasis.opendocument.text"],
    ["book.epub", "application/epub+zip"],
    ["readme.md", "text/markdown"],
    ["page.html", "text/html"],
    ["image.webp", "image/webp"],
    ["sound.wav", "audio/wav"],
    ["unknown.xyz", "application/octet-stream"],
    ["Makefile", "application/octet-stream"],
    ["archive.tar.gz", "application/gzip"],
  ])("%s is a document of type %s", (name, mime) => {
    expect(kindOf(name, Buffer.from("anything"))).toEqual({ as: "document", mime })
  })
})

describe("a send as documents", () => {
  test.each([
    ["photo.jpg", JPEG, "image/jpeg"],
    ["clip.mp4", ftyp("isom"), "video/mp4"],
    ["song.mp3", MP3_FRAME, "audio/mpeg"],
    ["voice.ogg", ogg("OpusHead"), "audio/ogg"],
    ["report.pdf", Buffer.from("%PDF"), "application/pdf"],
    ["photo.jpg", PNG, "application/octet-stream"],
  ])("sends %s as a document of type %s", (name, head, mime) => {
    expect(kindOf(name, head, { asDocument: true })).toEqual({ as: "document", mime })
  })
})
