import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { ToolError } from "../errors"
import {
  FALLBACK_DIRS,
  WACLI_MIN_VERSION,
  WacliTooOldError,
  checkWacli,
  findWacli,
  parseVersion,
  resetWacliCache,
  runWacli,
  wacliArgs,
  wacliEnv,
} from "./wacli"
import { envelope, installFakeWacli, pathsIn, type FakeCall, type FakeWacli } from "./wacli.testing"

let fake: FakeWacli
const created: FakeWacli[] = []

async function install(version?: string): Promise<FakeWacli> {
  fake = await installFakeWacli({ version })
  created.push(fake)
  return fake
}

beforeEach(async () => {
  resetWacliCache()
  await install()
})

afterEach(async () => {
  await Promise.all(created.splice(0).map((installed) => installed.cleanup()))
})

/** The calls the fake got, without its version checks. */
async function commandCalls(): Promise<FakeCall[]> {
  return (await fake.calls()).filter((call) => call.argv[0] !== "version")
}

const FALLBACKS_EXIST = FALLBACK_DIRS.some((dir) => existsSync(join(dir, "wacli")))

describe("wacliEnv", () => {
  test("passes only what wacli needs to find itself", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/me",
      TMPDIR: "/tmp",
      LANG: "C",
      LC_ALL: "C",
      LC_CTYPE: "C",
      SECRET_TOKEN: "secret",
    }
    expect(wacliEnv(env)).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      TMPDIR: "/tmp",
      LANG: "C",
      LC_ALL: "C",
      LC_CTYPE: "C",
    })
  })

  test("leaves out variables that are not set", () => {
    expect(wacliEnv({ PATH: "/bin", HOME: undefined })).toEqual({ PATH: "/bin" })
  })

  test("drops the caller's WACLI_ variables and sets the media roots to the outbox", () => {
    const paths = pathsIn("/state")
    const env = wacliEnv(
      { PATH: "/bin", WACLI_STORE_DIR: "/elsewhere", WACLI_READONLY: "0", WACLI_MEDIA_ROOTS: "/" },
      paths,
    )
    expect(env).toEqual({ PATH: "/bin", WACLI_MEDIA_ROOTS: paths.outbox })
  })

  test("sets no media roots without a label", () => {
    expect(wacliEnv({ PATH: "/bin", WACLI_MEDIA_ROOTS: "/" })).toEqual({ PATH: "/bin" })
  })
})

describe("findWacli", () => {
  test("finds wacli on PATH", async () => {
    expect(await findWacli(fake.env)).toBe(join(fake.dir, "wacli"))
  })

  test("skips a file that is not executable", async () => {
    const first = await install()
    const second = await install()
    chmodSync(join(first.dir, "wacli"), 0o644)
    const env = { PATH: [first.dir, second.dir].join(delimiter) }
    expect(await findWacli(env)).toBe(join(second.dir, "wacli"))
  })

  test.skipIf(FALLBACKS_EXIST)("fails as not_found, pointing at the install page", async () => {
    const error = await findWacli({ PATH: join(fake.dir, "missing") }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("not_found")
    expect((error as ToolError).message).toContain("https://github.com/openclaw/wacli")
  })
})

describe("parseVersion", () => {
  test("reads the first major.minor.patch", () => {
    expect(parseVersion("0.26.0\n")).toEqual([0, 26, 0])
    expect(parseVersion("wacli v1.2.30 (abc)")).toEqual([1, 2, 30])
  })

  test("returns null without one", () => {
    expect(parseVersion("")).toBeNull()
    expect(parseVersion("dev")).toBeNull()
    expect(parseVersion("1.2")).toBeNull()
  })
})

describe("checkWacli", () => {
  test("returns the program and its version", async () => {
    expect(await checkWacli(fake.env)).toEqual({ program: join(fake.dir, "wacli"), version: "0.26.0" })
  })

  test("accepts a newer version", async () => {
    expect((await checkWacli((await install("0.31.4")).env)).version).toBe("0.31.4")
    expect((await checkWacli((await install("1.0.0")).env)).version).toBe("1.0.0")
  })

  test("refuses an older version, saying to update", async () => {
    const error = await checkWacli((await install("0.25.9")).env).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("upstream_error")
    expect((error as ToolError).message).toBe(
      `wacli 0.25.9 is older than ${WACLI_MIN_VERSION}, which these tools need; update wacli (https://github.com/openclaw/wacli).`,
    )
    expect(error).toBeInstanceOf(WacliTooOldError)
    expect((error as WacliTooOldError).version).toBe("0.25.9")
  })

  test("refuses output that is not a version", async () => {
    const error = await checkWacli((await install("not a version")).env).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("upstream_error")
    expect((error as ToolError).message).toContain(WACLI_MIN_VERSION)
  })

  test("asks once per program, until the cache is reset", async () => {
    const versionCalls = async () => (await fake.calls()).filter((call) => call.argv[0] === "version").length
    await checkWacli(fake.env)
    await checkWacli(fake.env)
    expect(await versionCalls()).toBe(1)
    resetWacliCache()
    await checkWacli(fake.env)
    expect(await versionCalls()).toBe(2)
  })

  test("does not remember a refusal", async () => {
    const old = await install("0.25.0")
    await checkWacli(old.env).catch(() => {})
    await checkWacli(old.env).catch(() => {})
    expect((await old.calls()).filter((call) => call.argv[0] === "version")).toHaveLength(2)
  })
})

describe("wacliArgs", () => {
  const paths = pathsIn("/state")

  test("puts the store and JSON before the command", () => {
    expect(wacliArgs(paths, ["chats", "list"], { readOnly: false })).toEqual([
      "--store",
      paths.store,
      "--json",
      "chats",
      "list",
    ])
  })

  test("adds --read-only for a read", () => {
    expect(wacliArgs(paths, ["chats", "list"], { readOnly: true })).toEqual([
      "--store",
      paths.store,
      "--json",
      "--read-only",
      "chats",
      "list",
    ])
  })
})

describe("runWacli", () => {
  const paths = pathsIn("/state")

  test("returns the data of the envelope", async () => {
    fake.setResponses([{ args: ["chats", "list"], stdout: envelope({ chats: [{ jid: "1@g.us" }] }) }])
    const data = await runWacli(paths, ["chats", "list"], { env: fake.env, mode: "read" })
    expect(data).toEqual({ chats: [{ jid: "1@g.us" }] })
  })

  test("reads the envelope past status lines on both streams", async () => {
    fake.setResponses([
      {
        args: ["chats"],
        stdout: `connecting...\n${envelope([1, 2])}`,
        stderr: 'syncing\n{"event":"progress"}\n',
      },
    ])
    expect(await runWacli(paths, ["chats"], { env: fake.env, mode: "read" })).toEqual([1, 2])
  })

  test("runs a read with the store, JSON and --read-only", async () => {
    fake.setResponses([{ args: ["chats", "list"], stdout: envelope([]) }])
    await runWacli(paths, ["chats", "list"], { env: fake.env, mode: "read" })
    const [call] = await commandCalls()
    expect(call?.argv).toEqual(["--store", paths.store, "--json", "--read-only", "chats", "list"])
  })

  test("runs an ask without --read-only, which wacli refuses for asking WhatsApp", async () => {
    fake.setResponses([{ args: ["contacts", "check"], stdout: envelope([]) }])
    await runWacli(paths, ["contacts", "check", "--", "+15550000001"], { env: fake.env, mode: "ask" })
    const [call] = await commandCalls()
    expect(call?.argv).toEqual(["--store", paths.store, "--json", "contacts", "check", "--", "+15550000001"])
  })

  test("runs a write without --read-only", async () => {
    fake.setResponses([{ args: ["send", "text"], stdout: envelope({ id: "A1" }) }])
    await runWacli(paths, ["send", "text", "--to", "1@s.whatsapp.net"], { env: fake.env, mode: "write" })
    const [call] = await commandCalls()
    expect(call?.argv).toEqual(["--store", paths.store, "--json", "send", "text", "--to", "1@s.whatsapp.net"])
  })

  test("gives wacli the outbox as its media roots and no other WACLI_ variable", async () => {
    fake.setResponses([{ args: ["chats"], stdout: envelope(null) }])
    const env = { ...fake.env, WACLI_STORE_DIR: "/elsewhere", WACLI_READONLY: "0", WACLI_MEDIA_ROOTS: "/" }
    await runWacli(paths, ["chats"], { env, mode: "read" })
    const [call] = await commandCalls()
    expect(call?.env).toEqual({ WACLI_MEDIA_ROOTS: paths.outbox })
  })

  test("does not run the command of a wacli that is too old", async () => {
    const old = await install("0.20.0")
    old.setResponses([{ args: ["chats"], stdout: envelope([]) }])
    const error = await runWacli(paths, ["chats"], { env: old.env, mode: "read" }).catch((caught: unknown) => caught)
    expect((error as ToolError).code).toBe("upstream_error")
    expect((await old.calls()).map((call) => call.argv)).toEqual([["version"]])
  })

  test.skipIf(FALLBACKS_EXIST)("fails as not_found when wacli is not installed", async () => {
    const error = await runWacli(paths, ["chats"], { env: { PATH: join(fake.dir, "missing") }, mode: "write" }).catch(
      (caught: unknown) => caught,
    )
    expect((error as ToolError).code).toBe("not_found")
  })
})

test("the fake is executable and starts with a node shebang", () => {
  const program = join(fake.dir, "wacli")
  expect(readFileSync(program, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node")
  expect(statSync(program).mode & 0o777).toBe(0o755)
})
