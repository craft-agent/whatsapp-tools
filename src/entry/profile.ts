import type { OptionType, Toolsets } from "../core"
import { PROJECT } from "../project"

/** What an entry point takes from the package's identity: its name, the prefix of its settings' environment variables, its toolsets and the types of its tool options. */
export type EntryProfile = {
  name: string
  envPrefix: string
  toolsets: Toolsets
  options?: Readonly<Record<string, OptionType>>
}

/** The profile of this package, which every entry point uses unless a test supplies its own. */
export const PROJECT_PROFILE: EntryProfile = {
  name: PROJECT.name,
  envPrefix: PROJECT.envPrefix,
  toolsets: { names: PROJECT.toolsets, defaults: PROJECT.defaultToolsets },
  options: PROJECT.options,
}
