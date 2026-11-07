import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { ToolError } from "../errors"
import { eventually } from "./sync.testing"
import { spawnWacli } from "./wacli-process"
import { installFakeWacli, type FakeResponse, type FakeWacli } from "./wacli.testing"

let fake: FakeWacli

beforeEach(async () => {
  fake = await installFakeWacli()
})

afterEach(async () => {
  await fake.cleanup()
})

/** The line the fake writes first, so a test knows that it is up and handles SIGTERM. */
const READY = "ready"

/** Starts the fake's `run` command, which answers as `response` says; `ready` resolves once the fake is up. */
function spawnFake(response: Omit<FakeResponse, "args">, options: { stopGraceMs?: number } = {}) {
  fake.setResponses([{ args: ["run"], ...response, stderrLines: [{ line: READY }, ...(response.stderrLines ?? [])] }])
  const stdout: string[] = []
  const stderr: string[] = []
  let up = false
  const wacli = spawnWacli(join(fake.dir, "wacli"), ["run"], {
    env: fake.env,
    onStdoutLine: (line) => stdout.push(line),
    onStderrLine: (line) => (line === READY ? (up = true) : stderr.push(line)),
    ...options,
  })
  return { wacli, stdout, stderr, ready: () => eventually(() => up) }
}

describe("spawnWacli output", () => {
  test("hands over each line of both streams, without line breaks", async () => {
    const { wacli, stdout, stderr } = spawnFake({ stdout: "one\r\ntwo\n", stderr: "alpha\nbeta\n" })
    expect(await wacli.exited).toEqual({ code: 0, signal: null })
    expect(stdout).toEqual(["one", "two"])
    expect(stderr).toEqual(["alpha", "beta"])
  })

  test("hands over a last line that has no line break", async () => {
    const { wacli, stdout } = spawnFake({ stdout: "one\npartial" })
    await wacli.exited
    expect(stdout).toEqual(["one", "partial"])
  })

  test("joins a line that arrives in pieces", async () => {
    fake.setResponses([{ args: ["run"], stderr: "first ", stderrLines: [{ line: "whole line", afterMs: 20 }] }])
    const lines: string[] = []
    const wacli = spawnWacli(join(fake.dir, "wacli"), ["run"], { env: fake.env, onStderrLine: (l) => lines.push(l) })
    await wacli.exited
    expect(lines).toEqual(["first whole line"])
  })

  test("masks numbers in standard error but not in standard output", async () => {
    const { wacli, stdout, stderr } = spawnFake({
      stdout: "to +15551234567\n",
      stderr: "from 15551234567@s.whatsapp.net and +1 555 123 4567\n",
    })
    await wacli.exited
    expect(stdout).toEqual(["to +15551234567"])
    expect(stderr).toEqual(["from <number>@s.whatsapp.net and <number>"])
  })

  test("keeps going when a callback throws", async () => {
    fake.setResponses([{ args: ["run"], stderr: "a\nb\n" }])
    const seen: string[] = []
    const wacli = spawnWacli(join(fake.dir, "wacli"), ["run"], {
      env: fake.env,
      onStderrLine(line) {
        seen.push(line)
        throw new Error("callback failed")
      },
    })
    await wacli.exited
    expect(seen).toEqual(["a", "b"])
  })
})

describe("spawnWacli ending", () => {
  test("reports the exit code", async () => {
    const { wacli } = spawnFake({ exit: 3 })
    expect(await wacli.exited).toEqual({ code: 3, signal: null })
  })

  test("has a process id", async () => {
    const { wacli } = spawnFake({})
    expect(wacli.pid).toBeGreaterThan(0)
    await wacli.exited
  })

  test("stop sends SIGTERM and resolves once the process exited", async () => {
    const { wacli, stderr, ready } = spawnFake({ hang: true, onTerm: { exit: 7, stderr: "stopping\n" } })
    await ready()
    await wacli.stop()
    expect(await wacli.exited).toEqual({ code: 7, signal: null })
    expect(stderr).toEqual(["stopping"])
  })

  test("stop is safe to call again, also after the process ended", async () => {
    const { wacli, ready } = spawnFake({ hang: true })
    await ready()
    await Promise.all([wacli.stop(), wacli.stop()])
    await wacli.stop()
    expect((await wacli.exited).code).toBe(0)
  })

  test("stop sends SIGKILL when SIGTERM is ignored for the grace period", async () => {
    const { wacli, ready } = spawnFake({ hang: true, ignoreTerm: true }, { stopGraceMs: 300 })
    await ready()
    await wacli.stop()
    expect(await wacli.exited).toEqual({ code: null, signal: "SIGKILL" })
  })

  test("reports the signal that ended the process", async () => {
    const { wacli, ready } = spawnFake({ hang: true })
    await ready()
    const [call] = await fake.calls()
    process.kill(call!.pid, "SIGKILL")
    expect(await wacli.exited).toEqual({ code: null, signal: "SIGKILL" })
  })
})

describe("spawnWacli start failures", () => {
  test("rejects exited with upstream_error for a program that cannot be started", async () => {
    const wacli = spawnWacli(join(fake.dir, "missing"), [], { env: fake.env })
    const error = await wacli.exited.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("upstream_error")
    expect((error as ToolError).message).toContain("ENOENT")
    await wacli.stop()
  })
})
