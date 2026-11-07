import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NotAFolder } from "./fs-safe"
import { Staging } from "./staging"

let root: string
let outside: string
let staging: Staging

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "staging-"))
  root = join(base, "root")
  outside = join(base, "outside")
  mkdirSync(root)
  mkdirSync(outside)
  staging = new Staging(root)
})
afterEach(() => rmSync(join(root, ".."), { recursive: true, force: true }))

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part)
}

const mode = (path: string) => statSync(path).mode & 0o777

describe("writing an unpacked tree", () => {
  test("makes each folder 0700 and each file 0600, never executable", async () => {
    await staging.directory(["a", "b"])
    await staging.file(["a", "b", "run.sh"], chunks("#!/bin/sh\n", "echo hi\n"))
    await staging.file(["top.txt"], chunks())
    expect(mode(join(root, "a"))).toBe(0o700)
    expect(mode(join(root, "a", "b"))).toBe(0o700)
    expect(mode(join(root, "a", "b", "run.sh"))).toBe(0o600)
    expect(readFileSync(join(root, "a", "b", "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n")
    expect(readFileSync(join(root, "top.txt"), "utf8")).toBe("")
  })

  test("makes the folders a file needs, and reuses a folder that exists", async () => {
    await staging.file(["x", "y", "one.txt"], chunks("1"))
    await staging.file(["x", "y", "two.txt"], chunks("2"))
    expect(readdirSync(join(root, "x", "y")).sort()).toEqual(["one.txt", "two.txt"])
  })
})

describe("a link in the way is never followed", () => {
  test("a link where a folder is needed is refused, for a folder and for a file below it", async () => {
    symlinkSync(outside, join(root, "link"))
    await expect(staging.directory(["link", "sub"])).rejects.toBeInstanceOf(NotAFolder)
    await expect(staging.file(["link", "evil.txt"], chunks("x"))).rejects.toBeInstanceOf(NotAFolder)
    expect(readdirSync(outside)).toEqual([])
  })

  test("a link deeper down is refused too", async () => {
    mkdirSync(join(root, "real"))
    symlinkSync(outside, join(root, "real", "link"))
    await expect(staging.file(["real", "link", "evil.txt"], chunks("x"))).rejects.toBeInstanceOf(NotAFolder)
    expect(readdirSync(outside)).toEqual([])
  })

  test("a link at a file's name is not written through, whether it leads to a file or nowhere", async () => {
    const victim = join(outside, "victim.txt")
    writeFileSync(victim, "keep me")
    symlinkSync(victim, join(root, "to-victim"))
    symlinkSync(join(outside, "nowhere.txt"), join(root, "dangling"))
    await expect(staging.file(["to-victim"], chunks("overwritten"))).rejects.toMatchObject({ code: "EEXIST" })
    await expect(staging.file(["dangling"], chunks("created"))).rejects.toMatchObject({ code: "EEXIST" })
    expect(readFileSync(victim, "utf8")).toBe("keep me")
    expect(readdirSync(outside)).toEqual(["victim.txt"])
  })

  test("a file where a folder is needed, and a file that exists, are refused", async () => {
    writeFileSync(join(root, "taken"), "first")
    await expect(staging.directory(["taken", "sub"])).rejects.toBeInstanceOf(NotAFolder)
    await expect(staging.file(["taken"], chunks("second"))).rejects.toMatchObject({ code: "EEXIST" })
    expect(readFileSync(join(root, "taken"), "utf8")).toBe("first")
  })
})
