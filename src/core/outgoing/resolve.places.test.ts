import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertResolvedFile } from "./identity"
import { createSandbox, toolFailure, type Sandbox } from "./outgoing.testing"
import { resolveOutgoing } from "./resolve"
import { allowedRoots } from "./roots"

let box: Sandbox
let work: string
let home: string
beforeEach(() => {
  box = createSandbox()
  work = box.mkdir("work")
  home = box.mkdir("home")
})
afterEach(() => box.remove())

const resolveIn = (path: string, extra: { roots?: string[]; forbidden?: string[] } = {}) =>
  resolveOutgoing(path, { cwd: work, roots: extra.roots ?? [work, home], forbidden: extra.forbidden ?? [], home })

/** Whether the file system under the temp directory ignores case, as APFS and NTFS do by default. */
function ignoresCase(): boolean {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "case-")))
  try {
    mkdirSync(join(dir, "Probe"))
    return existsSync(join(dir, "pROBE"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("resolveOutgoing and hard links", () => {
  test("refuses a file with more than one name, wherever the other name is", async () => {
    const hidden = box.write("work/.ssh/notes.txt")
    linkSync(hidden, join(work, "innocent.txt"))
    const error = await toolFailure(() => resolveIn("innocent.txt"))
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe(
      '"innocent.txt" has more than one name (a hard link), so where it really lives cannot be told.',
    )
    const elsewhere = box.write("elsewhere/plain.txt")
    linkSync(elsewhere, join(work, "plain.txt"))
    expect((await toolFailure(() => resolveIn("plain.txt"))).code).toBe("forbidden")
  })

  test("takes a file with one name, and says which file it is", async () => {
    const file = box.write("work/plain.txt")
    const resolved = await resolveIn("plain.txt")
    expect(resolved.realPath).toBe(file)
    expect(typeof resolved.identity.dev).toBe("bigint")
    expect(typeof resolved.identity.ino).toBe("bigint")
  })
})

describe("assertResolvedFile", () => {
  const stat = async (path: string) => {
    const handle = await open(path, "r")
    try {
      return await handle.stat({ bigint: true })
    } finally {
      await handle.close()
    }
  }

  test("accepts the file that was resolved", async () => {
    const file = box.write("work/plain.txt")
    const { identity } = await resolveIn("plain.txt")
    assertResolvedFile(await stat(file), identity, '"plain.txt"')
  })

  test("is stale for another file at the same path", async () => {
    const file = box.write("work/plain.txt")
    const { identity } = await resolveIn("plain.txt")
    // Kept aside rather than removed, so the file system cannot hand its inode to the new file.
    renameSync(file, join(work, "kept-aside.txt"))
    box.write("work/other.txt")
    linkSync(join(work, "other.txt"), file)
    rmSync(join(work, "other.txt"))
    const error = await toolFailure(async () => assertResolvedFile(await stat(file), identity, '"plain.txt"'))
    expect(error.code).toBe("stale")
  })

  test("is forbidden for a file that has gained a name since", async () => {
    const file = box.write("work/plain.txt")
    const { identity } = await resolveIn("plain.txt")
    linkSync(file, join(work, "second-name.txt"))
    const error = await toolFailure(async () => assertResolvedFile(await stat(file), identity, '"plain.txt"'))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("hard link")
  })

  test("is invalid for what is not a regular file", async () => {
    const { identity } = await resolveIn((box.write("work/plain.txt"), "plain.txt"))
    const error = await toolFailure(async () => assertResolvedFile(await stat(work), identity, '"plain.txt"'))
    expect(error.code).toBe("invalid_argument")
  })
})

describe("resolveOutgoing and places that hold logins, cookies and messages", () => {
  test.each(
    [
      ["Google", "Chrome/Default/notes.txt"],
      ...["Chromium", "BraveSoftware", "Firefox", "Microsoft Edge", "Arc", "Vivaldi", "com.operasoftware.Opera"],
      ...["1Password", "Bitwarden", "Signal", "Slack", "discord", "Telegram Desktop", "MobileSync"],
    ].map((app) => (Array.isArray(app) ? app : [app, "x.txt"])),
  )("refuses Library/Application Support/%s below the home directory", async (app, below) => {
    const file = box.write(`home/Library/Application Support/${app}/${below}`)
    const error = await toolFailure(() => resolveIn(file))
    expect(error.code).toBe("forbidden")
    expect(error.message).toContain("holds logins, cookies or messages")
    expect(error.message).toContain(`(Library/Application Support/${app})`)
  })

  test.each(["Safari", "Mail", "Messages", "Cookies", "HTTPStorages", "Containers", "Group Containers"])(
    "refuses Library/%s below the home directory",
    async (folder) => {
      const file = box.write(`home/Library/${folder}/some/x.txt`)
      expect((await toolFailure(() => resolveIn(file))).message).toContain(`(Library/${folder})`)
    },
  )

  test.each([
    ".local/share/signal-cli/data/x.txt",
    ".wacli/main/session.db",
    ".var/app/org.example.App/x.txt",
    "snap/firefox/x.txt",
  ])("refuses %s below the home directory", async (below) => {
    const file = box.write(`home/${below}`)
    expect((await toolFailure(() => resolveIn(file))).code).toBe("forbidden")
  })

  test("refuses these in any case, and Library/Keychains too", async () => {
    const signal = box.write("home/library/application support/SIGNAL/x.txt")
    expect((await toolFailure(() => resolveIn(signal))).code).toBe("forbidden")
    const keychains = box.write("home/Library/Keychains/readme.txt")
    expect((await toolFailure(() => resolveIn(keychains))).code).toBe("forbidden")
  })

  test("allows the rest of Library, and the same names away from the home directory", async () => {
    const notes = box.write("home/Library/Application Support/Notes/a.txt")
    expect((await resolveIn(notes)).name).toBe("a.txt")
    const elsewhere = box.write("work/Library/Application Support/Signal/a.txt")
    expect((await resolveIn(elsewhere)).name).toBe("a.txt")
    const documents = box.write("home/Library/Preferences/a.txt")
    expect((await resolveIn(documents)).name).toBe("a.txt")
    const snapshot = box.write("home/snapshots/a.txt")
    expect((await resolveIn(snapshot)).name).toBe("a.txt")
  })

  test("looks at the real path: a link out of such a place is judged by where it leads", async () => {
    const profile = box.write("home/Library/Application Support/Google/Login.txt")
    box.link("work/harmless.txt", profile)
    expect((await toolFailure(() => resolveIn("harmless.txt"))).code).toBe("forbidden")
  })
})

describe("containment on a file system that ignores case", () => {
  const onCaseBlind = test.skipIf(!ignoresCase())

  onCaseBlind("realpath gives the case on disk, so a path in another case is still inside its directory", async () => {
    const state = box.mkdir("State")
    const file = box.write("State/label/keys.txt")
    const given = join(box.root, "STATE", "label", "KEYS.TXT")
    expect(await toolFailure(() => resolveIn(given, { roots: [box.root], forbidden: [state] }))).toMatchObject({
      code: "forbidden",
    })
    expect(
      await toolFailure(() => resolveIn(file, { roots: [box.root], forbidden: [join(box.root, "sTaTe")] })),
    ).toMatchObject({ code: "forbidden" })
  })

  onCaseBlind(
    "roots are real paths in the case on disk, and a root in another case inside a forbidden directory is dropped",
    async () => {
      const state = box.mkdir("State")
      box.mkdir("State/files")
      const roots = await allowedRoots({
        cwd: join(box.root, "WORK"),
        sendDirs: [join(box.root, "state", "FILES"), join(box.root, "work")],
        home,
        forbidden: [state],
      })
      expect(roots).toEqual([work])
    },
  )

  onCaseBlind("a denied folder is denied in any case, and a path in another case is not another file", async () => {
    box.write("work/.SSH/config.txt")
    const error = await toolFailure(() => resolveIn(join(work, ".ssh", "config.txt")))
    expect(error.code).toBe("forbidden")
    expect(error.message).toBe(
      `${JSON.stringify(join(work, ".ssh", "config.txt"))} is inside a key or settings folder.`,
    )
  })
})
