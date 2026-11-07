import { createConnection } from "node:net"
import { ToolError } from "../errors"
import { abortError } from "../exec"
import type { LabelPaths } from "./labels"
import { MAX_DEADLINE_MS, encodeLine, parseResponse } from "./service-protocol"
import type { WacliMode } from "./wacli"

/** How long a call may take unless the caller says otherwise. */
const DEFAULT_TIMEOUT_MS = 120_000

/** How long past its own deadline the service is given to answer, so its answer wins over the client's guess. */
const ANSWER_GRACE_MS = 1_000

const UNCERTAIN_ADVICE = "Check before trying again."

/** The message returned when the sync service for an account is not running. */
export function serviceNotRunningMessage(label: string): string {
  return `The sync service for account "${label}" is not running; start it first.`
}

/** Whether an error reports that the sync service is not running. */
export function isServiceNotRunning(error: unknown): boolean {
  return (
    error instanceof ToolError &&
    error.code === "upstream_error" &&
    error.message.includes("is not running; start it first")
  )
}

export type ServiceCallOptions = {
  /** What the operation may do; only `write` reports an outcome that is not known as `uncertain`, `read` and `ask` do not. */
  mode: WacliMode
  /** Abandons the call: it rejects with an `AbortError`, or `uncertain` for a write already submitted. */
  signal?: AbortSignal
  /** How long the call may take, also told to the service as its deadline; two minutes by default. */
  timeoutMs?: number
}

/**
 * Calls an operation of the label's sync service over its socket and returns its `data`.
 *
 * A failure known to happen before anything left (the service is not running, the connection was refused) is
 * `upstream_error`. Once the request was written, a closed connection, a time-out or an answer that cannot be read
 * is `uncertain` for a write and `upstream_error` for a read or an ask, and so is an abort of `signal` for a write
 * (a read or an ask rejects with an `AbortError`, as an abort before anything was written does for all). An error the service
 * answers with keeps its code.
 */
export function callService(
  paths: LabelPaths,
  op: string,
  args: unknown,
  { mode, signal, timeoutMs: requestedMs = DEFAULT_TIMEOUT_MS }: ServiceCallOptions,
): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  // The service takes a deadline in whole milliseconds, up to a bound.
  const timeoutMs = Number.isNaN(requestedMs)
    ? DEFAULT_TIMEOUT_MS
    : Math.min(Math.max(Math.ceil(requestedMs), 1), MAX_DEADLINE_MS)
  const request = encodeLine({ op, args, deadline_ms: timeoutMs })

  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socket)
    socket.setEncoding("utf8")
    let sent = false
    let received = ""
    let done = false

    const finish = (settle: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      socket.destroy()
      settle()
    }
    const fail = (error: ToolError) => finish(() => reject(error))
    const unknownOutcome = (what: string) =>
      fail(
        mode === "write"
          ? new ToolError("uncertain", `${what}, so the change may have taken effect. ${UNCERTAIN_ADVICE}`)
          : new ToolError("upstream_error", `${what}.`),
      )
    const notRunning = () => new ToolError("upstream_error", serviceNotRunningMessage(paths.label))
    function onAbort() {
      // A write that was already submitted may run or have run: giving up on it is not a cancellation.
      if (sent && mode === "write") {
        return fail(
          new ToolError(
            "uncertain",
            `The call was cancelled after the request was sent, so the change may have taken effect. ${UNCERTAIN_ADVICE}`,
          ),
        )
      }
      finish(() => reject(abortError(signal!)))
    }

    const timer = setTimeout(() => {
      if (sent) unknownOutcome(`The sync service did not answer within ${timeoutMs / 1000} s`)
      else fail(new ToolError("upstream_error", "The sync service did not take the request in time; nothing was sent."))
    }, timeoutMs + ANSWER_GRACE_MS)
    signal?.addEventListener("abort", onAbort, { once: true })

    socket.on("connect", () => {
      sent = true
      socket.write(request)
    })
    socket.on("data", (chunk: string) => {
      received += chunk
      const end = received.indexOf("\n")
      if (end === -1) return
      const response = parseResponse(received.slice(0, end))
      if (!response) return unknownOutcome("The sync service's answer could not be read")
      if (response.ok) return finish(() => resolve(response.data))
      fail(new ToolError(response.error.code, response.error.message))
    })
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (sent) return unknownOutcome("The connection to the sync service failed")
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") return fail(notRunning())
      fail(
        new ToolError("upstream_error", `The sync service could not be reached (${error.code ?? "error"}).`, {
          cause: error,
        }),
      )
    })
    socket.on("close", () => {
      if (sent) unknownOutcome("The connection to the sync service closed before it answered")
      else fail(notRunning())
    })
  })
}
