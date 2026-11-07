import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { resetWacliCache, runWacli, type WacliMode } from "./wacli"
import { installFakeWacli, pathsIn, type FakeMirror, type FakeWacli } from "./wacli.testing"

let fake: FakeWacli

beforeEach(async () => {
  resetWacliCache()
  fake = await installFakeWacli()
})

afterEach(async () => {
  await fake.cleanup()
})

function run(mode: WacliMode, ...args: string[]): Promise<any> {
  return runWacli(pathsIn(fake.dir), args, { env: fake.env, mode })
}

const contact = (jid: string, name: string, extra: Record<string, unknown> = {}) => ({
  jid,
  phone: jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : "",
  name,
  alias: "",
  system_name: "",
  updated_at: "2026-11-07T05:00:00Z",
  ...extra,
})

const MIRROR: FakeMirror = {
  contacts: [
    contact("15550100003@s.whatsapp.net", "Cy"),
    contact("15550100001@s.whatsapp.net", "Ann"),
    contact("15550100002@s.whatsapp.net", "ann-marie"),
    contact("99887766554433@lid", "", { alias: "Hidden Pal" }),
  ],
  check: {
    "15550100001": { registered: true, jid: "15550100001@s.whatsapp.net" },
    "15550100002": { registered: false },
    "15550100003": { registered: true, responded: false },
  },
}

describe("the fake wacli's contacts", () => {
  beforeEach(() => fake.setMirror(MIRROR))

  test("searches name, alias, phone and JID without regard to case, ordered by name then JID", async () => {
    const jids = async (query: string, ...flags: string[]) =>
      (await run("read", "contacts", "search", ...flags, "--", query)).map((found: { jid: string }) => found.jid)
    expect(await jids("ANN")).toEqual(["15550100001@s.whatsapp.net", "15550100002@s.whatsapp.net"])
    expect(await jids("pal")).toEqual(["99887766554433@lid"])
    expect(await jids("0100003")).toEqual(["15550100003@s.whatsapp.net"])
    expect(await jids("@lid")).toEqual(["99887766554433@lid"])
    expect(await jids("ann", "--limit", "1")).toEqual(["15550100001@s.whatsapp.net"])
  })

  test("prints null for no match and refuses a call without the query", async () => {
    expect(await run("read", "contacts", "search", "--", "nobody")).toBeNull()
    const error = await run("read", "contacts", "search").catch((caught: unknown) => caught)
    expect((error as ToolError).code).toBe("invalid_argument")
  })

  test("checks each number as WhatsApp answered, leaving out the ones it did not", async () => {
    const results = await run(
      "ask",
      "contacts",
      "check",
      "--",
      "+15550100001",
      "+15550100002",
      "+15550100003",
      "+15550100004",
    )
    expect(results).toEqual([
      {
        query: "+15550100001",
        phone: "15550100001",
        jid: "15550100001@s.whatsapp.net",
        registered: true,
        responded: true,
      },
      { query: "+15550100002", phone: "15550100002", registered: false, responded: true },
      { query: "+15550100003", phone: "15550100003", registered: true, responded: false },
      { query: "+15550100004", phone: "15550100004", registered: false, responded: false },
    ])
  })

  test("refuses the number check under --read-only, as wacli does", async () => {
    const error = await run("read", "contacts", "check", "--", "+15550100001").catch((caught: unknown) => caught)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect((error as ToolError).message).toContain("read-only mode")
  })
})
