import { readdirSync } from "node:fs"
import { join } from "node:path"

/** A signal that says "cancelled" at the first check for which `when` holds; for code that only calls `throwIfAborted`. */
export function abortWhen(when: () => boolean): AbortSignal {
  return {
    throwIfAborted() {
      if (when()) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    },
  } as unknown as AbortSignal
}

/** Every path below a folder, folders with a trailing slash. */
export function treeOf(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...treeOf(join(root, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
}
