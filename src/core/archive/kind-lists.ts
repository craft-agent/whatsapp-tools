/**
 * What a received file must not be, by the three things that can say so: its
 * name's extension, its declared MIME type and its first bytes. Each one can
 * lie, so any one that names a program, an installer or an archive that cannot
 * be inspected refuses the file.
 *
 * Source code is not here: `.bat`, `.cmd`, `.ps1`, `.vbs`, `.js`, `.wsf`,
 * `.wsh` and shell scripts run only when someone runs them, and are saved as
 * text. The macOS `.command`, `.terminal` and `.tool` files and the `.app`
 * family run when opened, and so are listed. Documents that are zips inside
 * (Office, OpenDocument, EPUB, iWork, XPS) are saved as one file: their parts
 * are the document, and they routinely embed other zips, so they are never
 * opened as archives (`DOCUMENT_EXTENSIONS`, `DOCUMENT_MIME_TYPES`). Their
 * macro-enabled forms run code when opened and are refused.
 */

/** Native code or a bundle of it, which runs when started or opened. */
export const PROGRAM = "a program"

/** A package that installs software. */
export const INSTALLER = "an installer"

/** An application packaged for a store or a runtime. */
export const APP_PACKAGE = "an app package"

/** A whole file system in one file. */
export const DISK_IMAGE = "a disk image"

/** An office document that carries macros, which run when it is opened. */
export const MACRO_DOCUMENT = "a document with macros"

/** An app or system bundle: a folder the system treats as one program or extension. */
export const BUNDLE = "an app or system bundle"

/** The reason for an archive format this package has no reader for: what cannot be read cannot be checked. */
function unreadableArchive(label: string): string {
  return `an archive that cannot be inspected (${label})`
}

/** Where a signature sits in a file and what it is. */
export type Signature = { offset: number; bytes: readonly number[] }

/** A file whose first bytes match every signature is refused for the reason. */
export type MagicRule = { reason: string; signatures: readonly Signature[] }

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "")
}

function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0))
}

function at(offset: number, bytes: readonly number[]): Signature {
  return { offset, bytes }
}

/** An archive format this package cannot read, by every way of recognizing it. */
type UnreadableArchive = {
  label: string
  extensions: string[]
  mimeTypes: string[]
  /** Each item is one way to recognize the format by its first bytes. */
  magic: Signature[][]
}

const UNREADABLE_ARCHIVES: readonly UnreadableArchive[] = [
  {
    label: "rar",
    extensions: ["rar"],
    mimeTypes: words("application/vnd.rar application/x-rar-compressed application/x-rar"),
    magic: [[at(0, [...ascii("Rar!"), 0x1a, 0x07])]],
  },
  {
    label: "7z",
    extensions: ["7z"],
    mimeTypes: ["application/x-7z-compressed"],
    magic: [[at(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])]],
  },
  {
    label: "bzip2",
    extensions: words("bz2 bzip2 tbz tbz2"),
    mimeTypes: words("application/x-bzip2 application/x-bzip"),
    magic: [[at(0, ascii("BZh")), at(4, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59])]],
  },
  {
    label: "xz",
    extensions: words("xz txz"),
    mimeTypes: ["application/x-xz"],
    magic: [[at(0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])]],
  },
  {
    label: "zstd",
    extensions: words("zst zstd tzst"),
    mimeTypes: words("application/zstd application/x-zstd"),
    magic: [[at(0, [0x28, 0xb5, 0x2f, 0xfd])]],
  },
  { label: "lzip", extensions: ["lz"], mimeTypes: ["application/x-lzip"], magic: [[at(0, ascii("LZIP"))]] },
  { label: "lzma", extensions: words("lzma tlz"), mimeTypes: ["application/x-lzma"], magic: [] },
  { label: "lz4", extensions: ["lz4"], mimeTypes: ["application/x-lz4"], magic: [[at(0, [0x04, 0x22, 0x4d, 0x18])]] },
  { label: "compress", extensions: ["z"], mimeTypes: ["application/x-compress"], magic: [[at(0, [0x1f, 0x9d])]] },
  {
    label: "cab",
    extensions: ["cab"],
    mimeTypes: ["application/vnd.ms-cab-compressed"],
    magic: [[at(0, ascii("MSCF"))]],
  },
  { label: "iso", extensions: ["iso"], mimeTypes: ["application/x-iso9660-image"], magic: [] },
  { label: "img", extensions: ["img"], mimeTypes: [], magic: [] },
  {
    label: "ar",
    extensions: words("ar a"),
    mimeTypes: words("application/x-archive application/x-unix-archive"),
    magic: [[at(0, ascii("!<arch>\n"))]],
  },
  // cpio has no signature that text, which may start with the same digits, cannot also have
  { label: "cpio", extensions: ["cpio"], mimeTypes: ["application/x-cpio"], magic: [] },
  { label: "arj", extensions: ["arj"], mimeTypes: ["application/x-arj"], magic: [] },
  { label: "lzh", extensions: words("lzh lha"), mimeTypes: ["application/x-lzh-compressed"], magic: [] },
  { label: "ace", extensions: ["ace"], mimeTypes: ["application/x-ace-compressed"], magic: [] },
  { label: "stuffit", extensions: words("sit sitx"), mimeTypes: ["application/x-stuffit"], magic: [] },
  { label: "wim", extensions: ["wim"], mimeTypes: [], magic: [[at(0, [...ascii("MSWIM"), 0x00, 0x00, 0x00])]] },
]

function reasonMap(groups: readonly (readonly [string, readonly string[]])[]): ReadonlyMap<string, string> {
  return new Map(groups.flatMap(([reason, names]) => names.map((name): [string, string] => [name, reason])))
}

/** Extensions (lower case, without the dot) by the reason a file named with one is refused. */
export const REFUSED_EXTENSIONS: ReadonlyMap<string, string> = reasonMap([
  // Windows executables, what loads as one, and the files Windows opens by running something
  [
    PROGRAM,
    words("exe com scr cpl hta msc reg inf lnk pif dll sys drv ocx efi application appref-ms gadget jnlp xbap"),
  ],
  // Unix and macOS binaries and bundles, and the macOS files that run when opened
  [PROGRAM, words("elf so dylib ko kext app workflow plugin prefpane command terminal tool")],
  // Bytecode that runs on a virtual machine
  [PROGRAM, words("class wasm")],
  [INSTALLER, words("msi msp msu mst pkg mpkg deb rpm snap flatpak flatpakref appimage")],
  [INSTALLER, words("appx appxbundle msix msixbundle appinstaller vsix")],
  [APP_PACKAGE, words("apk aab ipa jar war ear xpi crx")],
  [DISK_IMAGE, words("dmg sparseimage sparsebundle vhd vhdx vmdk")],
  [MACRO_DOCUMENT, words("docm xlsm pptm xlsb dotm xltm potm ppsm sldm xlam ppam")],
  ...UNREADABLE_ARCHIVES.map(({ label, extensions }): [string, string[]] => [unreadableArchive(label), extensions]),
])

/** MIME types (lower case, without parameters) by the reason a file declared as one is refused. */
export const REFUSED_MIME_TYPES: ReadonlyMap<string, string> = reasonMap([
  [
    PROGRAM,
    words(`
      application/x-msdownload application/x-dosexec application/vnd.microsoft.portable-executable
      application/x-executable application/x-elf application/x-sharedlib application/x-pie-executable
      application/x-mach-binary application/java-vm application/wasm application/x-ms-shortcut
      application/hta application/x-ms-application application/x-java-jnlp-file
    `),
  ],
  [
    INSTALLER,
    words(`
      application/x-msi application/x-debian-package application/vnd.debian.binary-package application/x-deb
      application/x-rpm application/x-redhat-package-manager application/x-xar
      application/x-newton-compatible-pkg application/vnd.appimage application/x-iso9660-appimage
    `),
  ],
  [
    APP_PACKAGE,
    words(`
      application/java-archive application/x-java-archive application/vnd.android.package-archive
      application/x-chrome-extension application/x-xpinstall application/x-itunes-ipa
    `),
  ],
  [DISK_IMAGE, ["application/x-apple-diskimage"]],
  ...UNREADABLE_ARCHIVES.map(({ label, mimeTypes }): [string, string[]] => [unreadableArchive(label), mimeTypes]),
])

/** MIME type patterns (matched on the lower-case type) by the reason a file declared as one is refused. */
export const REFUSED_MIME_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // application/vnd.ms-excel.sheet.macroEnabled.12 and the Word and PowerPoint kin
  [/^application\/vnd\.ms-.*\.macroenabled/, MACRO_DOCUMENT],
]

/** Extensions of documents that are zips inside and are saved as one file. */
export const DOCUMENT_EXTENSIONS: readonly string[] = words(
  "docx xlsx pptx odt ods odp odg epub pages numbers key vsdx xps oxps",
)

/** MIME types of those documents, exactly. */
export const DOCUMENT_MIME_TYPES: readonly string[] = words(
  "application/epub+zip application/vnd.ms-xpsdocument application/oxps application/vnd.ms-visio.drawing application/vnd.apple.pages application/vnd.apple.numbers application/vnd.apple.keynote",
)

/** Prefixes of the MIME types of Office Open XML and OpenDocument documents. */
export const DOCUMENT_MIME_PREFIXES: readonly string[] = [
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.oasis.opendocument.",
]

/**
 * Extensions of folders the system treats as one program or extension. A
 * path with a component that ends in one is refused in an archive, listed or
 * not, since unpacking it makes the bundle.
 */
export const BUNDLE_EXTENSIONS: readonly string[] = words(
  "app framework bundle kext plugin prefpane workflow action appex xpc qlgenerator mdimporter saver component mpkg pkg dsym",
)

function rule(reason: string, ...signatures: Signature[]): MagicRule {
  return { reason, signatures }
}

/**
 * Signatures checked in order, so the Debian package is found before the plain
 * `ar` archive it is made of. OLE compound files (`.doc`, `.xls`, and `.msi`)
 * are not here: their bytes alone do not tell an installer from a document, so
 * only the name or the type refuses an `.msi`. A DOS `MZ` header is checked
 * separately (`isDosExecutable` in `kind.ts`), since two letters alone would
 * catch text.
 */
export const MAGIC_RULES: readonly MagicRule[] = [
  rule(PROGRAM, at(0, [0x7f, 0x45, 0x4c, 0x46])), // ELF, which also covers an AppImage
  rule(PROGRAM, at(0, [0xfe, 0xed, 0xfa, 0xce])), // Mach-O, 32-bit big-endian
  rule(PROGRAM, at(0, [0xfe, 0xed, 0xfa, 0xcf])), // Mach-O, 64-bit big-endian
  rule(PROGRAM, at(0, [0xce, 0xfa, 0xed, 0xfe])), // Mach-O, 32-bit little-endian
  rule(PROGRAM, at(0, [0xcf, 0xfa, 0xed, 0xfe])), // Mach-O, 64-bit little-endian
  rule(PROGRAM, at(0, [0xca, 0xfe, 0xba, 0xbe])), // a universal Mach-O or a Java class: both are programs
  rule(PROGRAM, at(0, [0xbe, 0xba, 0xfe, 0xca])), // a universal Mach-O, little-endian
  rule(PROGRAM, at(0, [0xca, 0xfe, 0xba, 0xbf])), // a universal Mach-O with 64-bit offsets
  rule(PROGRAM, at(0, [0xbf, 0xba, 0xfe, 0xca])), // the same, little-endian
  rule(PROGRAM, at(0, [0x00, 0x61, 0x73, 0x6d]), at(4, [0x01, 0x00, 0x00, 0x00])), // WebAssembly
  rule(PROGRAM, at(0, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])), // a Windows shortcut
  rule(INSTALLER, at(0, ascii("xar!"))), // a macOS .pkg
  rule(INSTALLER, at(0, [0xed, 0xab, 0xee, 0xdb])), // an RPM package
  rule(INSTALLER, at(0, ascii("!<arch>\ndebian"))), // a Debian package
  ...UNREADABLE_ARCHIVES.flatMap(({ label, magic }) =>
    magic.map((signatures) => rule(unreadableArchive(label), ...signatures)),
  ),
]

/** Extensions that say a file is a zip archive, in lower case without the dot. */
export const ZIP_EXTENSIONS: readonly string[] = ["zip"]

/** Extensions that say a file is a tar archive. */
export const TAR_EXTENSIONS: readonly string[] = ["tar"]

/** Extensions that say a file is gzip, which is accepted only as a gzipped tar. */
export const GZIP_EXTENSIONS: readonly string[] = ["gz", "tgz"]

/** MIME types that say a file is a zip archive. */
export const ZIP_MIME_TYPES: readonly string[] = words("application/zip application/x-zip-compressed application/x-zip")

/** MIME types that say a file is a tar archive. */
export const TAR_MIME_TYPES: readonly string[] = words("application/x-tar application/x-gtar")

/** MIME types that say a file is gzip. */
export const GZIP_MIME_TYPES: readonly string[] = words(
  "application/gzip application/x-gzip application/x-compressed-tar",
)
