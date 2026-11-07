import { afterAll, describe, expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { createFixtures, refusal } from "./archive.testing"
import { inspectArchive } from "./inspect"
import { DEFAULT_LIMITS } from "./limits"
import { buildTar } from "./tar.testing"
import { walkArchive } from "./walk"
import { buildZip } from "./zip.testing"

const fixtures = createFixtures()
afterAll(() => fixtures.remove())

const files = [
  { name: "dir/", dir: true },
  { name: "dir/a.txt", data: "alpha" },
  { name: "dir/b.txt", data: "b".repeat(100_000) },
  { name: "c.txt", data: "" },
]

const zipPath = () => fixtures.write("w.zip", buildZip(files))
const tarPath = () =>
  fixtures.write(
    "w.tar",
    buildTar(files.map((f) => (f.dir ? { name: f.name, type: "5" } : { name: f.name, data: f.data }))),
  )

async function collect(data: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const chunk of data) parts.push(chunk)
  return Buffer.concat(parts)
}

describe.each([
  ["zip", zipPath],
  ["tar", tarPath],
] as const)("walking a %s", (format, make) => {
  test("gives each entry in order, with its data once and null for a directory", async () => {
    const seen: Array<{ name: string; dir: boolean; size: number; length: number | null }> = []
    await walkArchive(make(), format, async (entry, data) => {
      seen.push({ ...entry, length: data === null ? null : (await collect(data)).length })
    })
    expect(seen).toEqual([
      { name: "dir/", dir: true, size: 0, length: null },
      { name: "dir/a.txt", dir: false, size: 5, length: 5 },
      { name: "dir/b.txt", dir: false, size: 100_000, length: 100_000 },
      { name: "c.txt", dir: false, size: 0, length: 0 },
    ])
  })

  test("reads the rest of an entry the handler left unread, so the next entry is still right", async () => {
    const names: string[] = []
    await walkArchive(make(), format, async (entry, data) => {
      names.push(entry.name)
      if (data !== null) for await (const _chunk of data) break
    })
    expect(names).toEqual(["dir/", "dir/a.txt", "dir/b.txt", "c.txt"])
  })

  test("reads an entry the handler never touched", async () => {
    const names: string[] = []
    await walkArchive(make(), format, async (entry) => {
      names.push(entry.name)
    })
    expect(names).toEqual(["dir/", "dir/a.txt", "dir/b.txt", "c.txt"])
  })

  test("stops at the handler's own error and passes it on", async () => {
    const boom = new Error("handler failed")
    const names: string[] = []
    const failure = walkArchive(make(), format, async (entry) => {
      names.push(entry.name)
      if (entry.name === "dir/a.txt") throw boom
    })
    await expect(failure).rejects.toBe(boom)
    expect(names).toEqual(["dir/", "dir/a.txt"])
  })

  test("holds the entry count to the limit", async () => {
    const error = await refusal(() => walkArchive(make(), format, async () => {}, { ...DEFAULT_LIMITS, maxEntries: 3 }))
    expect(error.message).toBe("the archive has more than 3 entries")
  })

  test("holds the total to the limit by the bytes read, across entries", async () => {
    const limits = { ...DEFAULT_LIMITS, maxTotalSize: 100_002 }
    const error = await refusal(() => walkArchive(make(), format, async () => {}, limits))
    expect(error.reason).toBe("the archive unpacks to more than 100002 bytes")
  })

  test("fails for a file that is not there", async () => {
    await expect(walkArchive("/nonexistent/archive", format, async () => {})).rejects.toThrow()
  })
})

describe.each([
  ["zip", zipPath],
  ["tar", tarPath],
] as const)("the input of walking a %s", (format, make) => {
  test("a link at the path is refused, not followed", async () => {
    const real = make()
    const link = join(dirname(real), `link-to-${format}`)
    symlinkSync(real, link)
    const error = await refusal(() => walkArchive(link, format, async () => {}))
    expect(error.reason).toBe("the archive is a link, not a file")
    await expect(inspectArchive(link, format)).rejects.toMatchObject({ reason: "the archive is a link, not a file" })
  })

  test("a dangling link is refused too", async () => {
    const link = join(dirname(make()), `dangling-${format}`)
    symlinkSync(join(dirname(link), "nowhere"), link)
    await expect(walkArchive(link, format, async () => {})).rejects.toThrow()
  })

  test("something that is not a regular file is refused", async () => {
    const error = await refusal(() => walkArchive(dirname(make()), format, async () => {}))
    expect(error.reason).toBe("the archive is not a regular file")
  })

  test("a cancellation stops the walk before the next chunk of data is read", async () => {
    let checks = 0
    const signal = { throwIfAborted: () => void (++checks > 3 && abort()) } as unknown as AbortSignal
    const read: number[] = []
    const stopped = walkArchive(
      make(),
      format,
      async (entry, data) => {
        if (data !== null) for await (const chunk of data) read.push(chunk.length)
        expect(entry.name).toBeDefined()
      },
      DEFAULT_LIMITS,
      signal,
    )
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" })
    expect(read.reduce((sum, length) => sum + length, 0)).toBeLessThan(100_005)
  })

  test("a signal that never says so changes nothing", async () => {
    const signal = new AbortController().signal
    const names: string[] = []
    await walkArchive(make(), format, async (entry) => void names.push(entry.name), DEFAULT_LIMITS, signal)
    expect(names).toEqual(["dir/", "dir/a.txt", "dir/b.txt", "c.txt"])
  })
})

function abort(): never {
  throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
}

test("inspecting stops at a cancellation as well", async () => {
  let checks = 0
  const signal = { throwIfAborted: () => void (++checks > 2 && abort()) } as unknown as AbortSignal
  await expect(inspectArchive(zipPath(), "zip", DEFAULT_LIMITS, signal)).rejects.toMatchObject({ name: "AbortError" })
})
