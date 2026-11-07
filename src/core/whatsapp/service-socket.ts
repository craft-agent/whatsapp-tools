import { chmod, rm } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { isAbortError, isToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { maskNumbers } from "./mask"
import {
  encodeLine,
  failureResponse,
  parseRequest,
  type ServiceRequest,
  type ServiceResponse,
} from "./service-protocol"

/** The longest request line the socket reads. */
const MAX_REQUEST_BYTES = 1_048_576

/** How long a connection may stay silent before it has sent its request line. */
const REQUEST_READ_TIMEOUT_MS = 10_000

/** The longest operation name quoted in a message. */
const MAX_QUOTED_OP = 40

/** How much of an unexpected error's text goes to the log. */
const MAX_LOGGED_ERROR = 200

const SOCKET_MODE = 0o600

const STOPPING = "The sync service is stopping; the request was not run."
const WAITED_TOO_LONG = "The request waited in the sync service's queue past its deadline and was not run."
const STOPPED_WHILE_RUNNING =
  "The sync service stopped while the request was running, so the change may have taken effect. Check before trying again."
const OUT_OF_TIME =
  "The request ran out of time in the sync service, so the change may have taken effect. Check before trying again."
const INTERNAL_ERROR = "The sync service failed while running the request."

/** What an operation gets to work with. */
export type ServiceOperationContext = {
  paths: LabelPaths
  /** The service's environment; `runWacli` and the like pick what they pass on from it. */
  env: Record<string, string | undefined>
  /** Aborts when the service stops or the request's deadline passes; an operation gives up then. */
  signal: AbortSignal
}

/**
 * An operation the service runs for a caller. `delegated` runs while the sync child runs (it runs wacli, which
 * hands the request to the running sync); `exclusive` runs with the child stopped, and the service starts the child
 * again whatever becomes of the run. A `ToolError` thrown by `run` reaches the caller with its code.
 */
export type ServiceOperation = {
  kind: "delegated" | "exclusive"
  run(args: unknown, context: ServiceOperationContext): Promise<unknown>
}

/** The operations the service takes by name. */
export type ServiceOperations = Record<string, ServiceOperation>

/** Runs one operation as its kind demands; the socket calls it for one request at a time. */
export type ServiceExecutor = (operation: ServiceOperation, args: unknown, signal: AbortSignal) => Promise<unknown>

export type ServiceSocketOptions = {
  operations: ServiceOperations
  execute: ServiceExecutor
  log(line: string): void
}

/** The service's listening socket. */
export type ServiceSocket = {
  /**
   * Stops listening, aborts the request that is running, answers the queued ones as not run, waits for the running
   * one to finish, and removes the socket file. Safe to call again.
   */
  close(): Promise<void>
}

/** One request from accept to answer. */
type Job = {
  socket: Socket
  request: ServiceRequest
  /** Aborts when the request's `deadline_ms` has passed, counted from its arrival. */
  deadline: AbortSignal | undefined
  /** Whether it reached its turn in the queue. */
  started: boolean
  /** Whether its deadline passed while it was queued, which was answered already. */
  expired: boolean
}

function quoteOp(op: string): string {
  const masked = maskNumbers(op)
  return JSON.stringify(masked.length > MAX_QUOTED_OP ? `${masked.slice(0, MAX_QUOTED_OP)}…` : masked)
}

/**
 * Serves the sync service's socket at `path`: one JSON request per connection, answered with one JSON line, and
 * requests run strictly one at a time in the order they arrived. A request whose connection closed before its turn
 * is dropped, so a caller that gave up is not run later behind its back. A stale socket file is removed first.
 */
export async function listenOnServiceSocket(path: string, options: ServiceSocketOptions): Promise<ServiceSocket> {
  const { operations, execute, log } = options
  const sockets = new Set<Socket>()
  const shutdown = new AbortController()
  let queue: Promise<void> = Promise.resolve()
  let closing: Promise<void> | undefined

  const answer = (socket: Socket, response: ServiceResponse) => {
    if (socket.destroyed) return
    try {
      let line: string
      try {
        line = encodeLine(response)
      } catch {
        line = encodeLine(failureResponse("internal_error", INTERNAL_ERROR))
      }
      socket.end(line)
    } catch {
      // A connection that cannot be written to is dropped; the service goes on.
      socket.destroy()
    }
  }

  const failureOf = (error: unknown, signal: AbortSignal, op: string): ServiceResponse => {
    if (isToolError(error)) return failureResponse(error.code, error.message)
    if (signal.aborted || isAbortError(error)) {
      return failureResponse("uncertain", shutdown.signal.aborted ? STOPPED_WHILE_RUNNING : OUT_OF_TIME)
    }
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unexpected error"
    log(`operation ${quoteOp(op)} failed: ${maskNumbers(detail).slice(0, MAX_LOGGED_ERROR)}`)
    return failureResponse("internal_error", INTERNAL_ERROR)
  }

  const runRequest = async (job: Job) => {
    const { socket, request, deadline } = job
    const operation = operations[request.op]
    job.started = true
    if (!operation || job.expired || socket.destroyed) return
    if (shutdown.signal.aborted) return answer(socket, failureResponse("upstream_error", STOPPING))
    const signal = deadline ? AbortSignal.any([shutdown.signal, deadline]) : shutdown.signal
    try {
      answer(socket, { ok: true, data: (await execute(operation, request.args, signal)) ?? null })
    } catch (error) {
      answer(socket, failureOf(error, signal, request.op))
    }
  }

  const accept = (socket: Socket, line: string) => {
    const request = parseRequest(line)
    if (!request) return answer(socket, failureResponse("invalid_argument", "The request is not a valid request."))
    if (!Object.hasOwn(operations, request.op)) {
      return answer(socket, failureResponse("invalid_argument", `Unknown operation ${quoteOp(request.op)}.`))
    }
    const deadline = request.deadline_ms === undefined ? undefined : AbortSignal.timeout(request.deadline_ms)
    const job: Job = { socket, request, deadline, started: false, expired: false }
    // A request still queued when its deadline passes is answered at once as not run, and skipped at its turn.
    deadline?.addEventListener(
      "abort",
      () => {
        if (job.started) return
        job.expired = true
        answer(socket, failureResponse("upstream_error", WAITED_TOO_LONG))
      },
      { once: true },
    )
    // `runRequest` answers every failure itself; the catch only keeps one stray error from stopping the queue.
    queue = queue.then(() => runRequest(job)).catch(() => {})
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
    socket.setEncoding("utf8")
    socket.setTimeout(REQUEST_READ_TIMEOUT_MS, () => socket.destroy())
    let received = ""
    let requested = false
    let tooLarge = false
    socket.on("data", (chunk: string) => {
      if (requested) return
      // A request over the limit is read to its end and dropped, then answered: answering while the caller is still
      // writing would close a connection with unread data, which can reset it before the answer is read.
      if (tooLarge) {
        if (chunk.includes("\n")) {
          requested = true
          answer(socket, failureResponse("invalid_argument", "The request is too large."))
        }
        return
      }
      received += chunk
      const end = received.indexOf("\n")
      if (end === -1) {
        if (received.length > MAX_REQUEST_BYTES) {
          tooLarge = true
          received = ""
        }
        return
      }
      requested = true
      socket.setTimeout(0)
      try {
        accept(socket, received.slice(0, end))
      } catch (error) {
        // Nothing a request does may escape this handler and end the service: it is answered, or its connection dropped.
        log(`a request could not be handled: ${maskNumbers(error instanceof Error ? error.name : "unexpected error")}`)
        answer(socket, failureResponse("internal_error", INTERNAL_ERROR))
      }
    })
  })

  await rm(path, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      resolve()
    })
  })
  try {
    await chmod(path, SOCKET_MODE)
  } catch (error) {
    server.close()
    await rm(path, { force: true })
    throw error
  }

  return {
    close() {
      closing ??= (async () => {
        shutdown.abort()
        const closed = new Promise<void>((resolve) => server.close(() => resolve()))
        await queue
        for (const socket of sockets) socket.end(() => socket.destroy())
        await closed
        await rm(path, { force: true })
      })()
      return closing
    },
  }
}
