import { env } from "node:process"
import { z } from "zod"
import { ToolError } from "../errors"
import type { LabelPaths } from "../whatsapp/labels"
import { runWacli } from "../whatsapp/wacli"

/** The most contacts one `contacts search` read returns, which is more than any account holds. */
const CONTACTS_LIMIT = 1_000_000

/** What the tool takes of a contact wacli prints; wacli's aliases, tags and system names are its own labels and stay out. */
const wacliContact = z.object({ jid: z.string(), name: z.string() })

/** One contact as wacli prints it. */
export type WacliContact = z.infer<typeof wacliContact>

/**
 * The contacts of the account's mirror whose name, alias, number or JID holds `query`, in wacli's order, read with
 * `wacli --read-only`; an abort of `signal` ends the call under way. wacli prints `null` for none.
 */
export async function readContacts(
  paths: LabelPaths,
  query: string,
  signal: AbortSignal | undefined,
): Promise<WacliContact[]> {
  // After `--`, so that a query starting with `-` is the query and not a flag.
  const data = await runWacli(paths, ["contacts", "search", "--limit", String(CONTACTS_LIMIT), "--", query], {
    env,
    mode: "read",
    signal,
  })
  const parsed = z.array(wacliContact).nullable().safeParse(data)
  if (!parsed.success) throw new ToolError("upstream_error", "wacli returned a contact list that cannot be read.")
  return parsed.data ?? []
}
