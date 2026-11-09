import { isWithin } from "../paths"

/** The first of `directories` that `path` is, or is inside (compared by real path, component by component), or `undefined`. */
export async function containing(path: string, directories: readonly string[]): Promise<string | undefined> {
  for (const directory of directories) if (await isWithin(path, directory)) return directory
  return undefined
}
