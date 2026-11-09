import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { allowedRoots } from "./roots"
import { createSandbox, type Sandbox } from "./outgoing.testing"

let box: Sandbox
beforeEach(() => {
  box = createSandbox()
})
afterEach(() => box.remove())

describe("allowedRoots", () => {
  test("allows the working directory", async () => {
    const cwd = box.mkdir("work")
    const home = box.mkdir("home")
    expect(await allowedRoots({ cwd, sendDirs: [], home, forbidden: [] })).toEqual([cwd])
  })

  test("skips the working directory when it is the home directory, also through a link", async () => {
    const home = box.mkdir("home")
    expect(await allowedRoots({ cwd: home, sendDirs: [], home, forbidden: [] })).toEqual([])
    const linkedHome = box.link("home-link", home)
    expect(await allowedRoots({ cwd: home, sendDirs: [], home: linkedHome, forbidden: [] })).toEqual([])
    expect(await allowedRoots({ cwd: linkedHome, sendDirs: [], home, forbidden: [] })).toEqual([])
  })

  test("skips the working directory when it is a file system root", async () => {
    expect(await allowedRoots({ cwd: "/", sendDirs: [], home: box.mkdir("home"), forbidden: [] })).toEqual([])
  })

  test("adds the send directories after the working directory, each once, by real path", async () => {
    const cwd = box.mkdir("work")
    const shared = box.mkdir("shared")
    const linked = box.link("shared-link", shared)
    const roots = await allowedRoots({
      cwd,
      sendDirs: [shared, linked, join(shared, "..", "shared")],
      home: box.mkdir("home"),
      forbidden: [],
    })
    expect(roots).toEqual([cwd, shared])
  })

  test("keeps a send directory that is the home directory or a file system root, which the user named", async () => {
    const home = box.mkdir("home")
    expect(await allowedRoots({ cwd: box.mkdir("work"), sendDirs: [home, "/"], home, forbidden: [] })).toEqual([
      join(box.root, "work"),
      home,
      "/",
    ])
  })

  test("skips a send directory that does not exist", async () => {
    const cwd = box.mkdir("work")
    const file = box.write("work/a-file.txt")
    const roots = await allowedRoots({
      cwd,
      sendDirs: [join(box.root, "missing"), join(file, "below")],
      home: box.mkdir("home"),
      forbidden: [],
    })
    expect(roots).toEqual([cwd])
  })

  test("skips a working directory that does not exist", async () => {
    const home = box.mkdir("home")
    expect(await allowedRoots({ cwd: join(box.root, "gone"), sendDirs: [], home, forbidden: [] })).toEqual([])
  })

  test("resolves a link as the working directory", async () => {
    const work = box.mkdir("work")
    const linked = box.link("work-link", work)
    expect(await allowedRoots({ cwd: linked, sendDirs: [], home: box.mkdir("home"), forbidden: [] })).toEqual([work])
  })

  test("drops a root that is, or is inside, a forbidden directory", async () => {
    const state = box.mkdir("state")
    const inside = box.mkdir("state/label/files")
    const outside = box.mkdir("other")
    const stateLink = box.link("state-link", state)
    const roots = await allowedRoots({
      cwd: inside,
      sendDirs: [state, join(stateLink, "label"), outside],
      home: box.mkdir("home"),
      forbidden: [state],
    })
    expect(roots).toEqual([outside])
  })

  test("keeps a root that contains a forbidden directory, for the file check to refuse what is inside", async () => {
    const cwd = box.mkdir("work")
    const roots = await allowedRoots({
      cwd,
      sendDirs: [],
      home: box.mkdir("home"),
      forbidden: [join(cwd, "state"), join(box.root, "never-made")],
    })
    expect(roots).toEqual([cwd])
  })
})
