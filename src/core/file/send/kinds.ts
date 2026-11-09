import { extensionOf } from "../../archive/kind"
import type { SendAs } from "../../whatsapp/file-send"

/** How a file is shown, and the type wacli is told it has. */
export type SendKind = { as: SendAs; mime: string }

/** The type of a file whose name says nothing. */
const UNKNOWN_MIME = "application/octet-stream"

/** What a file looks like by its first bytes, for the extensions that may carry it. */
type Sniffer = SendKind & {
  extensions: readonly string[]
  /** Whether the first bytes are of that kind. */
  matches(head: Buffer): boolean
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GIF_MAGICS = ["GIF87a", "GIF89a"]
const ID3_MAGIC = "ID3"
const AMR_MAGIC = "#!AMR"
const OGG_MAGIC = "OggS"
const OPUS_HEAD = "OpusHead"

/** Where the box type of an ISO base media file (MP4, 3GP, M4A) is, and where its first brand is. */
const FTYP_OFFSET = 4
const BRAND_OFFSET = 8
const BRAND_LENGTH = 4

/** The first brand of an MP4 file that holds a video, as WhatsApp's own clients and common tools write it. */
const MP4_BRANDS: ReadonlySet<string> = new Set(["isom", "iso2", "mp41", "mp42", "avc1", "M4V "])

/** The first brand of an audio-only MP4 file. */
const M4A_BRAND = "M4A "

/** The prefix of the first brand of a 3GP file. */
const THREE_GP_BRAND = "3gp"

/** The first bytes of an MPEG audio frame: 11 bits of sync, and a version and a layer that name one. */
function isMpegFrame(head: Buffer): boolean {
  if (head.length < 3 || head[0] !== 0xff || (head[1]! & 0xe0) !== 0xe0) return false
  const version = (head[1]! >> 3) & 0b11
  const layer = (head[1]! >> 1) & 0b11
  const bitrate = head[2]! >> 4
  const rate = (head[2]! >> 2) & 0b11
  return version !== 0b01 && layer !== 0 && bitrate !== 0b1111 && rate !== 0b11
}

/** The first bytes of an AAC stream in ADTS frames: sync, layer 0 and no CRC or a CRC. */
function isAdts(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0xff && (head[1] === 0xf1 || head[1] === 0xf9)
}

function startsWithBytes(head: Buffer, bytes: readonly number[]): boolean {
  return head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte)
}

function startsWithText(head: Buffer, text: string, offset = 0): boolean {
  return head.length >= offset + text.length && head.toString("latin1", offset, offset + text.length) === text
}

/** The first brand of an ISO base media file, or undefined when the bytes are not one. */
function firstBrand(head: Buffer): string | undefined {
  if (!startsWithText(head, "ftyp", FTYP_OFFSET) || head.length < BRAND_OFFSET + BRAND_LENGTH) return undefined
  return head.toString("latin1", BRAND_OFFSET, BRAND_OFFSET + BRAND_LENGTH)
}

/**
 * Whether the first Ogg page holds the Opus identification header, which is its only packet: the header comes right
 * after the page's 27 bytes and its segment table. wacli sends every Ogg file as Opus, so one holding anything else
 * (Vorbis, FLAC) goes as a document.
 */
function isOpus(head: Buffer): boolean {
  if (!startsWithText(head, OGG_MAGIC) || head.length < 27) return false
  return startsWithText(head, OPUS_HEAD, 27 + head[26]!)
}

const SNIFFERS: readonly Sniffer[] = [
  {
    extensions: ["jpg", "jpeg"],
    as: "image",
    mime: "image/jpeg",
    matches: (head) => startsWithBytes(head, JPEG_MAGIC),
  },
  { extensions: ["png"], as: "image", mime: "image/png", matches: (head) => startsWithBytes(head, PNG_MAGIC) },
  {
    extensions: ["gif"],
    as: "image",
    mime: "image/gif",
    matches: (head) => GIF_MAGICS.some((magic) => startsWithText(head, magic)),
  },
  {
    extensions: ["mp4", "m4v"],
    as: "video",
    mime: "video/mp4",
    matches: (head) => MP4_BRANDS.has(firstBrand(head) ?? ""),
  },
  {
    extensions: ["3gp"],
    as: "video",
    mime: "video/3gpp",
    matches: (head) => firstBrand(head)?.startsWith(THREE_GP_BRAND) === true,
  },
  {
    extensions: ["mp3"],
    as: "audio",
    mime: "audio/mpeg",
    matches: (head) => startsWithText(head, ID3_MAGIC) || isMpegFrame(head),
  },
  { extensions: ["m4a"], as: "audio", mime: "audio/mp4", matches: (head) => firstBrand(head) === M4A_BRAND },
  { extensions: ["aac"], as: "audio", mime: "audio/aac", matches: isAdts },
  // wacli tells WhatsApp an Ogg file is Opus whatever it holds, so the type carries no parameters here.
  { extensions: ["ogg", "oga", "opus"], as: "audio", mime: "audio/ogg", matches: isOpus },
  { extensions: ["amr"], as: "audio", mime: "audio/amr", matches: (head) => startsWithText(head, AMR_MAGIC) },
]

/**
 * The types of the files that go as documents, by extension: what people send most, and the formats WhatsApp does
 * not show itself. A format a sniffer knows is not here, since a file that carries its extension without its bytes
 * has no honest type.
 */
const DOCUMENT_TYPES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    pdf: "application/pdf",
    txt: "text/plain",
    log: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    html: "text/html",
    htm: "text/html",
    xml: "application/xml",
    json: "application/json",
    rtf: "application/rtf",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
    tgz: "application/gzip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
    epub: "application/epub+zip",
    svg: "image/svg+xml",
    webp: "image/webp",
    heic: "image/heic",
    wav: "audio/wav",
    flac: "audio/flac",
    mov: "video/quicktime",
    webm: "video/webm",
  }),
)

/**
 * How a file named `name` whose first bytes are `head` is shown, and its type. A photo, a video or an audio message
 * only when the name and the bytes say the same: JPEG, PNG and GIF as photos, MP4 and 3GP as videos, MP3, M4A, AAC,
 * Opus in Ogg and AMR as audio. A file whose bytes do not match its name, and everything else, is a document, as is
 * every file when `asDocument` is set, which then keeps the type the bytes gave.
 */
export function kindOf(name: string, head: Buffer, { asDocument = false }: { asDocument?: boolean } = {}): SendKind {
  const extension = extensionOf(name)
  const sniffed = SNIFFERS.find((sniffer) => sniffer.extensions.includes(extension) && sniffer.matches(head))
  if (sniffed === undefined) return { as: "document", mime: DOCUMENT_TYPES.get(extension) ?? UNKNOWN_MIME }
  return asDocument ? { as: "document", mime: sniffed.mime } : { as: sniffed.as, mime: sniffed.mime }
}
