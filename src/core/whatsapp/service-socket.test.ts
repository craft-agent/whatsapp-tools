import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createConnection } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { ToolError } from "../errors"
import { callService } from "./service-client"
import type { ServiceOperation, ServiceOperations } from "./service-socket"
import { gate, startService, syncFixture, type SyncFixture } from "./sync.testing"
import { resetWacliCache } from "./wacli"

let fixture: SyncFixture
let stopService: (() => Promise<unknown>) | undefined

beforeEach(async () => {
  resetWacliCache()
  fixture = await syncFixture()
})

afterEach(async () => {
  await stopService?.()
  stopService = undefined
  await fixture.cleanup()
})

/** Starts the service with `operations`, to be stopped after the test. */
async function serve(operations: ServiceOperations) {
  const { outcome, stop } = await startService(fixture, operations)
  stopService = async () => {
    stop()
    await outcome
  }
}

const call = (op: string, args?: unknown, options: { timeoutMs?: number; mode?: "read" | "write" } = {}) =>
  callService(fixture.paths, op, args, { mode: "write", ...options })

/** Sends `text` as it is and returns the answer; an answer that is not JSON rejects with what arrived. */
function raw(text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(fixture.paths.socket)
    let received = ""
    socket.setEncoding("utf8")
    socket.on("connect", () => socket.write(text))
    socket.on("data", (chunk: string) => (received += chunk))
    socket.on("close", () => {
      try {
        resolve(JSON.parse(received))
      } catch {
        reject(new Error(`the service answered ${JSON.stringify(received.slice(0, 200))}`))
      }
    })
    socket.on("error", (error) =>
      reject(new Error(`the connection failed after ${JSON.stringify(received)}`, { cause: error })),
    )
  })
}

const echo: ServiceOperation = {
  kind: "delegated",
  async run(args, context) {
    return { args, label: context.paths.label, aborted: context.signal.aborted }
  },
}

describe("the service socket", () => {
  test("runs an operation with its arguments and the label's context, and returns its data", async () => {
    await serve({ echo })
    expect(await call("echo", { chat: "1@g.us", n: 2 })).toEqual({
      args: { chat: "1@g.us", n: 2 },
      label: "main",
      aborted: false,
    })
  })

  test("returns null for an operation that returns nothing", async () => {
    await serve({ nothing: { kind: "delegated", run: async () => undefined } })
    expect(await call("nothing")).toBeNull()
  })

  test("refuses an unknown operation as invalid_argument, also for names every object has", async () => {
    await serve({ echo })
    for (const op of ["missing", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const error = await call(op).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("invalid_argument")
      expect((error as ToolError).message).toContain(JSON.stringify(op))
    }
  })

  test("masks numbers in the name of an unknown operation", async () => {
    await serve({ echo })
    const error = (await call("15551234567@s.whatsapp.net").catch((caught: unknown) => caught)) as ToolError
    expect(error.message).not.toContain("5551234567")
  })

  test("refuses lines that are not requests, and keeps serving", async () => {
    await serve({ echo })
    const invalid = { ok: false, error: { code: "invalid_argument", message: expect.any(String) } }
    expect(await raw("not json\n")).toEqual(invalid)
    expect(await raw("[]\n")).toEqual(invalid)
    expect(await raw('{"args":1}\n')).toEqual(invalid)
    expect(await raw('{"op":""}\n')).toEqual(invalid)
    expect(await raw('{"op":3}\n')).toEqual(invalid)
    expect(await raw('{"op":"echo","deadline_ms":-5}\n')).toEqual(invalid)
    expect(await raw('{"op":"echo","deadline_ms":"soon"}\n')).toEqual(invalid)
    expect(await raw(`{"op":"echo","args":"${"x".repeat(1_100_000)}"}\n`)).toEqual(invalid)
    expect(await call("echo", 1)).toMatchObject({ args: 1 })
  })

  test("refuses a deadline that is not a whole number of milliseconds up to 24 hours, and keeps serving", async () => {
    await serve({ echo })
    const invalid = { ok: false, error: { code: "invalid_argument", message: expect.any(String) } }
    for (const deadline of [
      "1.5",
      "0.5",
      "0",
      "-1",
      "86400001",
      "1e300",
      "1e21",
      '"100"',
      "null",
      "true",
      "[]",
      "{}",
    ]) {
      expect(await raw(`{"op":"echo","deadline_ms":${deadline}}\n`)).toEqual(invalid)
      expect(await call("echo", 1)).toMatchObject({ args: 1 })
    }
    expect(await raw('{"op":"echo","args":1,"deadline_ms":86400000}\n')).toMatchObject({ ok: true })
    expect(await raw('{"op":"echo","args":1,"deadline_ms":1}\n')).toMatchObject({ ok: true })
  })

  test("runs requests strictly one at a time, in the order they arrived", async () => {
    const release = gate()
    const events: string[] = []
    let running = 0
    let mostAtOnce = 0
    const step: ServiceOperation = {
      kind: "delegated",
      async run(args) {
        const name = (args as { name: string }).name
        running++
        mostAtOnce = Math.max(mostAtOnce, running)
        events.push(`start ${name}`)
        if (name === "first") await release.opened
        else await delay(10)
        events.push(`end ${name}`)
        running--
        return name
      },
    }
    await serve({ step })

    const first = call("step", { name: "first" })
    await Promise.resolve()
    const results: Promise<unknown>[] = [first]
    for (const name of ["second", "third", "fourth"]) {
      results.push(call("step", { name }))
      await delay(40)
    }
    expect(events).toEqual(["start first"])
    release.open()

    expect(await Promise.all(results)).toEqual(["first", "second", "third", "fourth"])
    expect(events).toEqual([
      "start first",
      "end first",
      "start second",
      "end second",
      "start third",
      "end third",
      "start fourth",
      "end fourth",
    ])
    expect(mostAtOnce).toBe(1)
  })

  test("keeps serving after an operation fails", async () => {
    await serve({
      boom: { kind: "delegated", run: () => Promise.reject(new Error("boom")) },
      echo,
    })
    await call("boom").catch(() => {})
    expect(await call("echo", 1)).toMatchObject({ args: 1 })
  })
})

describe("the service socket's queue", () => {
  /** Holds the queue with an operation that waits for `release`. */
  async function serveBlocked(release: Promise<void>, ran: string[]) {
    await serve({
      block: { kind: "delegated", run: () => release },
      mark: {
        kind: "delegated",
        async run(args) {
          ran.push((args as { name: string }).name)
          return args
        },
      },
    })
  }

  test("does not run a request whose deadline passed while it waited", async () => {
    const release = gate()
    const ran: string[] = []
    await serveBlocked(release.opened, ran)
    const blocked = call("block")
    await delay(30)
    const late = await call("mark", { name: "late" }, { timeoutMs: 80 }).catch((caught: unknown) => caught)
    expect(late).toBeInstanceOf(ToolError)
    expect((late as ToolError).code).toBe("upstream_error")
    expect((late as ToolError).message).toContain("was not run")
    release.open()
    await blocked
    expect(await call("mark", { name: "after" })).toEqual({ name: "after" })
    expect(ran).toEqual(["after"])
  })

  test("drops a request whose caller gave up before its turn", async () => {
    const release = gate()
    const ran: string[] = []
    await serveBlocked(release.opened, ran)
    const blocked = call("block")
    await delay(30)
    const controller = new AbortController()
    const abandoned = callService(
      fixture.paths,
      "mark",
      { name: "abandoned" },
      { mode: "write", signal: controller.signal },
    )
    await delay(50)
    controller.abort()
    await abandoned.catch(() => {})
    await delay(50)
    release.open()
    await blocked
    expect(await call("mark", { name: "after" })).toEqual({ name: "after" })
    expect(ran).toEqual(["after"])
  })

  test("aborts a running operation whose deadline passes, as uncertain", async () => {
    const seen: string[] = []
    await serve({
      slow: {
        kind: "delegated",
        run: (_args, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              seen.push("aborted")
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            })
          }),
      },
    })
    const error = await call("slow", undefined, { timeoutMs: 100 }).catch((caught: unknown) => caught)
    expect((error as ToolError).code).toBe("uncertain")
    expect((error as ToolError).message).toContain("ran out of time")
    expect(seen).toEqual(["aborted"])
  })
})
