import type { Toolsets } from "../core"
import { PROJECT } from "../project"

/** What an entry point takes from the package's identity: its name, the prefix of its settings' environment variables, and its toolsets. */
export type EntryProfile = { name: string; envPrefix: string; toolsets: Toolsets }

/** The profile of this package, which every entry point uses unless a test supplies its own. */
export const PROJECT_PROFILE: EntryProfile = {
  name: PROJECT.name,
  envPrefix: PROJECT.envPrefix,
  toolsets: { names: PROJECT.toolsets, defaults: PROJECT.defaultToolsets },
}
