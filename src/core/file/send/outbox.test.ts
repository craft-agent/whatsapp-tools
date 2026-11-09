import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSandbox, toolFailure, type Sandbox } from "../../outgoing/outgoing.testing"
import { openCallFolder, removeCallFolder, sweepOutbox } from "./outbox"

let box: Sandbox
let outbox: string

beforeEach(() => {
  box = createSandbox()
  outbox = join(box.mkdir("label"), "outbox")
})
afterEach(() => box.remove())

const HOUR = 60 * 60 * 1000
const callFolder = (seed: string) => seed.repeat(32).slice(0, 32)

/** Makes a folder in the outbox as an earlier call would have, last touched `hoursAgo` hours ago. */
function leftover(name: string, hoursAgo: number): string {
  const folder = join(outbox, name)
  mkdirSync(join(folder, "0"), { recursive: true, mode: 0o700 })
  writeFileSync(join(folder, "0", "old.txt"), "left behind")
  const when = new Date(Date.now() - hoursAgo * HOUR)
  utimesSync(folder, when, when)
  return folder
}

describe("openCallFolder", () => {
  test("makes the outbox private when it is missing, and a new 32-hex folder in it each call", async () => {
    const first = await openCallFolder(outbox)
    const second = await openCallFolder(outbox)
    expect(first).not.toBe(second)
    expect(first).toMatch(new RegExp(`^${outbox}/[0-9a-f]{32}$`))
    expect(statSync(outbox).mode & 0o777).toBe(0o700)
    expect(statSync(first).mode & 0o777).toBe(0o700)
  })

  test("is refused when the outbox is a link, and writes nothing through it", async () => {
    const elsewhere = box.mkdir("elsewhere")
    box.link("label/outbox", elsewhere)
    const error = await toolFailure(() => openCallFolder(outbox))
    expect(error.code).toBe("internal_error")
    expect(error.message).not.toContain(box.root)
    expect(statSync(elsewhere).isDirectory()).toBe(true)
    expect(existsSync(join(elsewhere, "0"))).toBe(false)
  })

  test("is refused when a file is where the outbox belongs", async () => {
    box.write("label/outbox", "a file")
    expect((await toolFailure(() => openCallFolder(outbox))).code).toBe("internal_error")
  })
})

describe("removeCallFolder", () => {
  test("removes the folder with what is in it, and is fine when it is gone", async () => {
    const folder = leftover(callFolder("a"), 0)
    await removeCallFolder(folder)
    expect(existsSync(folder)).toBe(false)
    await removeCallFolder(folder)
  })
})

describe("sweepOutbox", () => {
  test("removes folders older than 24 hours and keeps newer ones", async () => {
    const old = leftover(callFolder("a"), 25)
    const recent = leftover(callFolder("b"), 23)
    await sweepOutbox(outbox, Date.now())
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  test("touches only folders named as this tool names them, and only real ones", async () => {
    const other = leftover("not-a-call-folder", 48)
    const file = join(outbox, callFolder("d"))
    writeFileSync(file, "a file")
    const elsewhere = box.mkdir("elsewhere")
    writeFileSync(join(elsewhere, "keep.txt"), "keep")
    box.link(`label/outbox/${callFolder("e")}`, elsewhere)
    const when = new Date(Date.now() - 48 * HOUR)
    utimesSync(file, when, when)
    await sweepOutbox(outbox, Date.now())
    expect(existsSync(other)).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true)
  })

  test("is quiet when there is no outbox", async () => {
    await sweepOutbox(outbox, Date.now())
    expect(existsSync(outbox)).toBe(false)
  })
})
