import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXIT_FAILED, EXIT_OK } from "./cli"
import { ADD_ID, READ_ID, cli, json, specs } from "./testing"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-target-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("target", () => {
  test("is the area argument as given, case kept", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], JSON.stringify({ area: "North/Hall" }))
    expect(run).toEqual({ code: EXIT_OK, stdout: '{"resources":["North/Hall"]}\n', stderr: "" })
  })

  test("is the working directory without an area argument", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/work/tree"]))).toEqual({ resources: ["/work/tree"] })
  })

  test("lists every target the call writes to, sorted", async () => {
    const stdin = JSON.stringify({ area: "south", parent: "east" })
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], stdin))).toEqual({ resources: ["east", "south"] })
  })

  test("is * for a tool that does not say what it writes to", async () => {
    expect(json(await cli(["target", READ_ID, "--cwd", "/x"]))).toEqual({ resources: ["*"] })
  })

  test("is * for a target that cannot be told, beside the others", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"area":"north","parent":""}'))).toEqual({
      resources: ["north", "*"],
    })
  })

  test("is * for arguments the schema does not accept", async () => {
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"area":3}'))).toEqual({ resources: ["*"] })
    expect(json(await cli(["target", ADD_ID, "--cwd", "/x"], '{"bogus":1}'))).toEqual({ resources: ["*"] })
  })

  test("is * in the install directory without an area, and still names an area given there", async () => {
    const own = tempDir()
    const argv = ["target", ADD_ID, "--cwd", own]
    expect(json(await cli(argv, "", { ownDir: own }))).toEqual({ resources: ["*"] })
    expect(json(await cli(argv, '{"area":"north"}', { ownDir: own }))).toEqual({ resources: ["north"] })
    expect(json(await cli(argv))).toEqual({ resources: [own] })
  })

  test("an unknown tool is invalid_argument", async () => {
    const run = await cli(["target", "demo_nonexistent_read", "--cwd", "/x"])
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })

  test("rejects stdin that is not JSON", async () => {
    const run = await cli(["target", ADD_ID, "--cwd", "/x"], "{nope")
    expect(run.code).toBe(EXIT_FAILED)
    expect(json(run).error.code).toBe("invalid_argument")
  })

  test("accepts --state-dir and passes stateDir into context for targets", async () => {
    let seenStateDir: string | undefined
    const checkTool = {
      ...specs[1]!,
      id: "demo_target_state",
      async targets(_args: unknown, ctx: { stateDir?: string }) {
        seenStateDir = ctx.stateDir
        return [ctx.stateDir ?? "none"]
      },
    }
    const run = await cli(["target", "demo_target_state", "--cwd", "/x", "--state-dir", "/flag/state"], "", {
      specs: [checkTool as any],
    })
    expect(run.code).toBe(EXIT_OK)
    expect(seenStateDir).toBe("/flag/state")
    expect(json(run)).toEqual({ resources: ["/flag/state"] })

    const runEqual = await cli(["target", "demo_target_state", "--cwd", "/x", "--state-dir=/flag/state/eq"], "", {
      specs: [checkTool as any],
    })
    expect(runEqual.code).toBe(EXIT_OK)
    expect(seenStateDir).toBe("/flag/state/eq")

    const runEnv = await cli(["target", "demo_target_state", "--cwd", "/x"], "", {
      specs: [checkTool as any],
      env: { DEMO_STATE_DIR: "/env/target/state" },
    })
    expect(runEnv.code).toBe(EXIT_OK)
    expect(seenStateDir).toBe("/env/target/state")
  })
})
