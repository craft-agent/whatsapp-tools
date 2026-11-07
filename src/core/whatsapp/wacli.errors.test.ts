import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError, type ErrorCode } from "../errors"
import { checkWacli, resetWacliCache, runWacli, wacliError, type WacliMode } from "./wacli"
import { envelope, failure, installFakeWacli, pathsIn, type FakeResponse, type FakeWacli } from "./wacli.testing"

const paths = pathsIn("/state")
const NUMBER = "15550000000"
const MODES: WacliMode[] = ["read", "write"]

let fake: FakeWacli

beforeEach(async () => {
  resetWacliCache()
  fake = await installFakeWacli()
})

afterEach(() => fake.cleanup())

/** What the fake prints and how it exits. */
type Answer = Pick<FakeResponse, "stdout" | "stderr" | "exit">

/** What a call of the fake that answers `answer` throws. */
async function thrownBy(mode: WacliMode, answer: Answer): Promise<ToolError> {
  fake.setResponses([{ args: ["probe"], ...answer }])
  const error = await runWacli(paths, ["probe"], { env: fake.env, mode }).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ToolError)
  return error as ToolError
}

/** The error `wacliError` makes for a failed call whose envelope says `text`. */
function errorFor(text: string, mode: WacliMode): ToolError {
  return wacliError({ code: 1, stdout: "", stderr: failure(text) }, mode)
}

describe("wacliError by the text of the envelope", () => {
  const refused: [string, string][] = [
    ["not authenticated", "not authenticated; run `wacli auth`"],
    ["revoked", "WhatsApp session was revoked: device removed"],
    ["login failed", "WhatsApp login failed: bad pairing"],
    ["logged out", "Logged out of WhatsApp (replaced); run wacli auth"],
  ]
  for (const [name, text] of refused) {
    test.each(MODES)(`${name} is unauthenticated for a %s`, (mode) => {
      const error = errorFor(text, mode)
      expect(error.code).toBe("unauthenticated")
      expect(error.message).toMatch(/pair/)
    })
  }

  test("a revoked session says so", () => {
    expect(errorFor("WhatsApp session was revoked: removed", "read").message).toContain("revoked")
  })

  const locked = ["store is locked (another wacli is running?): lock held", "timed out waiting for store lock after 5s"]
  for (const text of locked) {
    test.each(MODES)(`"${text}" is upstream_error for a %s, pointing at the service`, (mode) => {
      const error = errorFor(text, mode)
      expect(error.code).toBe("upstream_error")
      expect(error.message).toContain("held by another wacli process")
      expect(error.message).toContain("through the service")
    })
  }

  const invalid = [
    "read-only mode: send is not allowed",
    "unknown flag: --bogus",
    'unknown command "bogus" for "wacli"',
    "unknown shorthand flag: 'x' in -x",
    'required flag(s) "to" not set',
    'invalid argument "x" for "--limit" flag',
    "accepts 1 arg(s), received 0",
  ]
  for (const text of invalid) {
    test.each(MODES)(`"${text}" is invalid_argument for a %s`, (mode) => {
      const error = errorFor(text, mode)
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain(text)
    })
  }

  test.each([
    ["read", "upstream_error"],
    ["write", "uncertain"],
  ] as [WacliMode, ErrorCode][])("any other text is %s's unknown outcome: %s", (mode, code) => {
    const error = errorFor("something broke", mode)
    expect(error.code).toBe(code)
    expect(error.message).toContain("something broke")
  })

  test("an uncertain error tells the person to check first", () => {
    expect(errorFor("something broke", "write").message).toContain("may have taken effect. Check before trying again.")
  })

  test("an envelope without a text is still an error", () => {
    const result = { code: 1, stdout: "", stderr: '{"success":false,"data":null,"error":null}' }
    expect(wacliError(result, "write").code).toBe("uncertain")
    expect(wacliError(result, "read").code).toBe("upstream_error")
  })

  test("the envelope on stderr is found past other lines", () => {
    const stderr = `connecting\n{"event":"connected"}\n${failure("unknown flag: --x")}`
    expect(wacliError({ code: 1, stdout: "", stderr }, "read").code).toBe("invalid_argument")
  })
})

describe("a call without a usable envelope", () => {
  const cases: [string, Answer][] = [
    ["exit 0 with other output", { stdout: "hello\n", stderr: "" }],
    ["exit 0 with no output", { stdout: "", stderr: "" }],
    ["exit 0 with JSON that is not an envelope", { stdout: "[1]", stderr: "" }],
    ["exit 0 with a success envelope that has no data", { stdout: '{"success":true}\n', stderr: "" }],
    ["exit 1 with no envelope", { stdout: "", stderr: "panic: boom\n", exit: 1 }],
    ["exit 2", { stdout: envelope([]), stderr: "", exit: 2 }],
  ]
  for (const [name, response] of cases) {
    test(`${name}: upstream_error for a read`, async () => {
      expect((await thrownBy("read", response)).code).toBe("upstream_error")
    })
    test(`${name}: uncertain for a write`, async () => {
      expect((await thrownBy("write", response)).code).toBe("uncertain")
    })
  }

  test("a write that ended on a signal is uncertain", () => {
    const error = wacliError({ code: -1, stdout: "", stderr: "", signal: "SIGKILL" }, "write")
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("SIGKILL")
  })

  test("a read that ended on a signal is upstream_error", () => {
    expect(wacliError({ code: -1, stdout: "", stderr: "", signal: "SIGSEGV" }, "read").code).toBe("upstream_error")
  })

  test("carries at most the last 300 characters of stderr", async () => {
    const stderr = `${"a".repeat(500)}${"b".repeat(300)}`
    const error = await thrownBy("read", { stdout: "", stderr, exit: 1 })
    expect(error.message).toContain("b".repeat(300))
    expect(error.message).not.toContain("b".repeat(301))
    expect(error.message).not.toContain("aa")
  })

  test("a failure envelope on a successful exit is still an error", async () => {
    const error = await thrownBy("read", { stdout: failure("unknown flag: --x"), stderr: "" })
    expect(error.code).toBe("invalid_argument")
  })
})

describe("masking", () => {
  test.each(MODES)("a message built from the envelope text carries no number for a %s", (mode) => {
    const error = errorFor(`no such chat ${NUMBER}@s.whatsapp.net or 98765432101@lid`, mode)
    expect(error.message).toContain("<number>@s.whatsapp.net")
    expect(error.message).not.toMatch(/\d{5}/)
  })

  test.each(MODES)("a message built from stderr carries no number for a %s", async (mode) => {
    const error = await thrownBy(mode, { stdout: "", stderr: `crashed for +${NUMBER}\n`, exit: 1 })
    expect(error.message).toContain("<number>")
    expect(error.message).not.toMatch(/\d{5}/)
  })

  test("the revoked reason is masked too", () => {
    const error = errorFor(`WhatsApp session was revoked: ${NUMBER}@s.whatsapp.net replaced it`, "read")
    expect(error.message).not.toContain(NUMBER)
  })
})

describe("cancellation and time limits", () => {
  test("an abort rejects with the AbortError, not a ToolError", async () => {
    await checkWacli(fake.env)
    fake.setResponses([{ args: ["probe"], hang: true }])
    const controller = new AbortController()
    const running = runWacli(paths, ["probe"], { env: fake.env, mode: "write", signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    const error = await running.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ToolError)
    expect((error as Error).name).toBe("AbortError")
  })

  test("an abort before the call rejects at once", async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await runWacli(paths, ["probe"], { env: fake.env, mode: "read", signal: controller.signal }).catch(
      (caught: unknown) => caught,
    )
    expect((error as Error).name).toBe("AbortError")
  })

  test("a read that is not answered in time is upstream_error", async () => {
    await checkWacli(fake.env)
    fake.setResponses([{ args: ["probe"], hang: true }])
    const error = await runWacli(paths, ["probe"], { env: fake.env, mode: "read", timeoutMs: 500 }).catch(
      (caught: unknown) => caught,
    )
    expect((error as ToolError).code).toBe("upstream_error")
    expect((error as ToolError).message).toContain("did not answer within 0.5 s")
  })

  test("a write that is not answered in time is uncertain", async () => {
    await checkWacli(fake.env)
    fake.setResponses([{ args: ["probe"], hang: true }])
    const error = await runWacli(paths, ["probe"], { env: fake.env, mode: "write", timeoutMs: 500 }).catch(
      (caught: unknown) => caught,
    )
    expect((error as ToolError).code).toBe("uncertain")
    expect((error as ToolError).message).toContain("did not answer within 0.5 s")
    expect((error as ToolError).message).toContain("Check before trying again.")
  })
})
