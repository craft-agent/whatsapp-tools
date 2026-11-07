import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { callService } from "./service-client"
import type { LabelPaths } from "./labels"
import { ToolError } from "../errors"
import { eventually, shortTempDir } from "./sync.testing"
import { pathsIn } from "./wacli.testing"

let dir: string
let paths: LabelPaths
let server: Server | undefined
let requests: string[]
let connections: Socket[]

beforeEach(async () => {
  dir = await shortTempDir()
  paths = pathsIn(dir)
  await mkdir(paths.dir, { recursive: true })
  requests = []
  connections = []
})

afterEach(async () => {
  for (const socket of connections) socket.destroy()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)))
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

/** Serves the label's socket with `behave`, which gets each connection and the request line it sent. */
async function serve(behave: (socket: Socket, request: string) => void): Promise<void> {
  server = createServer((socket) => {
    connections.push(socket)
    socket.setEncoding("utf8")
    let received = ""
    socket.on("error", () => {})
    socket.on("data", (chunk: string) => {
      received += chunk
      if (!received.includes("\n")) return
      requests.push(received.trim())
      behave(socket, received)
      received = ""
    })
  })
  await new Promise<void>((resolve) => server!.listen(paths.socket, resolve))
}

async function failureOf(promise: Promise<unknown>): Promise<ToolError> {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ToolError)
  return error as ToolError
}

const SENT_NOTHING = 'The sync service for account "main" is not running; start it first.'

describe("callService when the service is not running", () => {
  test("is upstream_error naming the account when there is no socket", async () => {
    const error = await failureOf(callService(paths, "send", {}, { mode: "write" }))
    expect([error.code, error.message]).toEqual(["upstream_error", SENT_NOTHING])
  })

  test("is the same when a socket file was left behind by a service that is gone", async () => {
    const leftover = spawn(
      "node",
      ["-e", "require('net').createServer().listen(process.argv[1], () => console.log('up'))", paths.socket],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    await new Promise((resolve) => leftover.stdout.once("data", resolve))
    leftover.kill("SIGKILL")
    await new Promise((resolve) => leftover.once("exit", resolve))
    const error = await failureOf(callService(paths, "send", {}, { mode: "write" }))
    expect([error.code, error.message]).toEqual(["upstream_error", SENT_NOTHING])
  })

  test("is not uncertain, since nothing was sent, whatever the mode", async () => {
    for (const mode of ["read", "write"] as const) {
      expect((await failureOf(callService(paths, "x", undefined, { mode }))).code).toBe("upstream_error")
    }
  })
})

describe("callService with an answer", () => {
  test("sends one line with the operation, the arguments and the deadline, and returns the data", async () => {
    await serve((socket) => socket.end('{"ok":true,"data":{"sent":true}}\n'))
    expect(await callService(paths, "send", { chat: "1@g.us" }, { mode: "write", timeoutMs: 5000 })).toEqual({
      sent: true,
    })
    expect(requests.map((line) => JSON.parse(line))).toEqual([
      { op: "send", args: { chat: "1@g.us" }, deadline_ms: 5000 },
    ])
  })

  test("tells the service a deadline in whole milliseconds within its bound", async () => {
    await serve((socket) => socket.end('{"ok":true,"data":1}\n'))
    for (const timeoutMs of [1500.5, 0, -3, 1e300, Number.POSITIVE_INFINITY, Number.NaN]) {
      await callService(paths, "x", undefined, { mode: "read", timeoutMs })
    }
    const deadlines = requests.map((line) => (JSON.parse(line) as { deadline_ms: number }).deadline_ms)
    expect(deadlines).toEqual([1501, 1, 1, 86_400_000, 86_400_000, 120_000])
  })

  test("reads an answer that arrives in pieces", async () => {
    await serve((socket) => {
      socket.write('{"ok":tr')
      setTimeout(() => socket.end('ue,"data":[1,2]}\n'), 30)
    })
    expect(await callService(paths, "x", undefined, { mode: "read" })).toEqual([1, 2])
  })

  test("throws the error the service answered with, keeping its code, whatever the mode", async () => {
    await serve((socket) =>
      socket.end('{"ok":false,"error":{"code":"rate_limited","message":"slow down for a while"}}\n'),
    )
    for (const mode of ["read", "ask", "write"] as const) {
      const error = await failureOf(callService(paths, "x", undefined, { mode }))
      expect([error.code, error.message]).toEqual(["rate_limited", "slow down for a while"])
    }
  })
})

describe("callService when the outcome is not known", () => {
  const unknownOutcomes: [string, (socket: Socket) => void][] = [
    ["the connection closes without an answer", (socket) => socket.end()],
    ["the connection is reset", (socket) => socket.resetAndDestroy()],
    ["the answer is not JSON", (socket) => socket.end("hello\n")],
    ["the answer is not a response", (socket) => socket.end('{"ok":"yes"}\n')],
    ["the answer has a code nobody knows", (socket) => socket.end('{"ok":false,"error":{"code":"x","message":"y"}}\n')],
    ["the answer ends before its line does", (socket) => socket.end('{"ok":true,"data":1}')],
  ]

  for (const [name, behave] of unknownOutcomes) {
    test(`is uncertain for a write and upstream_error for a read or an ask when ${name}`, async () => {
      await serve((socket) => behave(socket))
      const write = await failureOf(callService(paths, "send", {}, { mode: "write" }))
      expect(write.code).toBe("uncertain")
      expect(write.message).toContain("Check before trying again")
      for (const mode of ["read", "ask"] as const) {
        const read = await failureOf(callService(paths, "look", {}, { mode }))
        expect(read.code).toBe("upstream_error")
        expect(read.message).not.toContain("Check before")
      }
    })
  }

  test("is uncertain for a write and upstream_error for a read when the service does not answer in time", async () => {
    await serve(() => {})
    const [write, read] = await Promise.all([
      failureOf(callService(paths, "send", {}, { mode: "write", timeoutMs: 100 })),
      failureOf(callService(paths, "look", {}, { mode: "read", timeoutMs: 100 })),
    ])
    expect([write.code, read.code]).toEqual(["uncertain", "upstream_error"])
    expect(write.message).toContain("did not answer within 0.1 s")
  })
})

describe("callService with an abort signal", () => {
  test("rejects with an AbortError, sending nothing, when already aborted", async () => {
    await serve((socket) => socket.end('{"ok":true,"data":1}\n'))
    const controller = new AbortController()
    controller.abort()
    const error = await callService(paths, "x", undefined, { mode: "write", signal: controller.signal }).catch(
      (caught: unknown) => caught,
    )
    expect((error as Error).name).toBe("AbortError")
    expect(requests).toEqual([])
  })

  test("rejects with an AbortError when aborted before the request was written, whatever the mode", async () => {
    await serve((socket) => socket.end('{"ok":true,"data":1}\n'))
    for (const mode of ["read", "ask", "write"] as const) {
      const controller = new AbortController()
      const pending = callService(paths, "send", {}, { mode, signal: controller.signal })
      const settled = pending.catch((caught: unknown) => caught)
      // The connection is still being made, so nothing has been written.
      controller.abort()
      const error = (await settled) as Error
      expect(error.name).toBe("AbortError")
      expect(error).not.toBeInstanceOf(ToolError)
    }
    expect(requests).toEqual([])
  })

  test("is uncertain for a write that was submitted when it is aborted while waiting", async () => {
    await serve(() => {})
    const controller = new AbortController()
    const settled = callService(paths, "send", {}, { mode: "write", signal: controller.signal }).catch(
      (caught: unknown) => caught,
    )
    await eventually(() => requests.length === 1)
    controller.abort()
    const error = await failureOf(settled)
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("Check before trying again")
    await eventually(() => connections.every((socket) => socket.destroyed))
  })

  test("rejects with an AbortError for a read or an ask that was submitted when it is aborted while waiting", async () => {
    await serve(() => {})
    for (const mode of ["read", "ask"] as const) {
      const controller = new AbortController()
      const settled = callService(paths, "look", {}, { mode, signal: controller.signal }).catch(
        (caught: unknown) => caught,
      )
      await eventually(() => requests.length === (mode === "read" ? 1 : 2))
      controller.abort()
      const error = (await settled) as Error
      expect(error.name).toBe("AbortError")
      expect(error).not.toBeInstanceOf(ToolError)
    }
  })
})
