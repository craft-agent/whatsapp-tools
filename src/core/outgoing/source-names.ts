import { extensionOf } from "../archive/kind"

/**
 * Extensions that say a file is source code in a scripting language, lower
 * case without the dot. Such a file is sent when its bytes are text, and
 * refused when they are not: a program called `run.sh` is not a script. Not
 * here: `.command`, `.terminal` and `.tool`, which macOS runs when opened and
 * which `classifyFile` refuses by name, and compiled forms (`.pyc`, `.scpt`),
 * which are not text. Not here either: `.ts`, `.mts` and `.cts`, which are as
 * often MPEG transport streams, a video format, as TypeScript.
 */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(
  `sh bash zsh fish ksh csh tcsh py pyw rb pl php lua tcl
   js mjs cjs jsx tsx
   ps1 psm1 bat cmd vbs vbe wsf wsh applescript`.split(/\s+/),
)

/** Whether the name's extension, read as `classifyFile` reads one, says the file is source code. */
export function isSourceName(name: string): boolean {
  return SOURCE_EXTENSIONS.has(extensionOf(name))
}
