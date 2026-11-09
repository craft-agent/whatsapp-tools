import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createSandbox, toolFailure, type Sandbox } from "./outgoing.testing"
import { resolveOutgoing } from "./resolve"

let box: Sandbox
let work: string
let outside: string
beforeEach(() => {
  box = createSandbox()
  work = box.mkdir("work")
  outside = box.write("outside/plain.txt")
})
afterEach(() => box.remove())

const resolveIn = (path: string, extra: { roots?: string[]; forbidden?: string[] } = {}) =>
  resolveOutgoing(path, {
    cwd: work,
    roots: extra.roots ?? [work],
    forbidden: extra.forbidden ?? [],
    home: join(box.root, "home"),
  })

describe("resolveOutgoing", () => {
  test("resolves a path relative to the working directory", async () => {
    const file = box.write("work/notes/today.txt")
    expect(await resolveIn("notes/today.txt")).toMatchObject({ realPath: file, name: "today.txt", root: work })
    expect(await resolveIn("./notes/../notes/today.txt")).toMatchObject({
      realPath: file,
      name: "today.txt",
      root: work,
    })
  })

  test("resolves an absolute path", async () => {
    const file = box.write("work/today.txt")
    expect(await resolveIn(file)).toMatchObject({ realPath: file, name: "today.txt", root: work })
  })

  test("does not expand ~, which is a folder name like any other", async () => {
    const error = await toolFailure(() => resolveIn("~/today.txt"))
    expect(error.code).toBe("not_found")
  })

  test("names the first root that contains the file", async () => {
    const file = box.write("work/deep/today.txt")
    const other = box.mkdir("other")
    expect(await resolveIn(file, { roots: [other, join(work, "deep"), work] })).toMatchObject({
      root: join(work, "deep"),
    })
  })

  test("refuses a path outside every root, saying how to allow it and naming no other path", async () => {
    for (const path of [outside, "../outside/plain.txt"]) {
      const error = await toolFailure(() => resolveIn(path))
      expect(error.code).toBe("forbidden")
      expect(error.message).toContain(JSON.stringify(path))
      expect(error.message).toContain("send_dirs")
      expect(error.message.replace(JSON.stringify(path), "")).not.toContain(box.root)
    }
  })

  test("compares by path components, not by string prefix", async () => {
    const sibling = box.write("work-extra/today.txt")
    const error = await toolFailure(() => resolveIn(sibling))
    expect(error.code).toBe("forbidden")
  })

  test("refuses a link that leads out of every root", async () => {
    box.link("work/out-link.txt", outside)
    box.link("work/out-dir", join(box.root, "outside"))
    for (const path of ["out-link.txt", "out-dir/plain.txt"]) {
      expect((await toolFailure(() => resolveIn(path))).code).toBe("forbidden")
    }
  })

  test("follows a link that stays inside a root, and reports what it leads to", async () => {
    const file = box.write("work/real/data.txt")
    box.link("work/alias.txt", file)
    box.link("work/alias-dir", join(work, "real"))
    expect(await resolveIn("alias.txt")).toMatchObject({ realPath: file, name: "data.txt" })
    expect(await resolveIn("alias-dir/data.txt")).toMatchObject({ realPath: file, name: "data.txt" })
  })

  test("takes a link into another root as that root's file", async () => {
    const linked = box.link("work/to-other.txt", outside)
    const root = join(box.root, "outside")
    expect(await resolveIn(linked, { roots: [work, root] })).toMatchObject({ realPath: outside, root })
  })

  test("refuses a file in a forbidden directory even when a root contains it, also through a link", async () => {
    const state = box.mkdir("work/state")
    box.write("work/state/label/keys.txt")
    box.link("work/state-link", state)
    for (const path of ["state/label/keys.txt", "state-link/label/keys.txt"]) {
      const error = await toolFailure(() => resolveIn(path, { forbidden: [state] }))
      expect(error.code).toBe("forbidden")
      expect(error.message).toContain(JSON.stringify(path))
      expect(error.message).not.toContain("send_dirs")
    }
  })

  test("a forbidden directory that is not there forbids nothing", async () => {
    box.write("work/today.txt")
    expect(await resolveIn("today.txt", { forbidden: [join(box.root, "never-made")] })).toMatchObject({
      name: "today.txt",
    })
  })

  test("a path that does not exist is not_found", async () => {
    expect((await toolFailure(() => resolveIn("missing.txt"))).code).toBe("not_found")
    box.link("work/dangling.txt", join(box.root, "gone.txt"))
    expect((await toolFailure(() => resolveIn("dangling.txt"))).code).toBe("not_found")
    box.write("work/file.txt")
    expect((await toolFailure(() => resolveIn("file.txt/below"))).code).toBe("not_found")
  })

  test("refuses what is not a regular file", async () => {
    box.mkdir("work/folder")
    const error = await toolFailure(() => resolveIn("folder"))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("not a regular file")
  })
})
