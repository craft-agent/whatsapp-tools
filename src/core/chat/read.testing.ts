import { mkdirSync, rmSync } from "node:fs"
import { ToolError } from "../errors"
import { invoke } from "../tool"
import { MS_PER_SECOND } from "../time"
import { labelPaths } from "../whatsapp/labels"
import { shortTempDir } from "../whatsapp/sync.testing"
import { resetWacliCache } from "../whatsapp/wacli"
import { installFakeWacli, type FakeMirror, type FakeWacli } from "../whatsapp/wacli.testing"
import type { ChatReadOutput } from "./schema"
import { whatsappChatRead } from "./read"

export const ALICE = "15550100001@s.whatsapp.net"
export const ALICE_NUMBER = "+15550100001"
export const BOB = "15550100002@s.whatsapp.net"
export const HIDDEN = "99887766554433@lid"
export const TEAM = "120363000000000001@g.us"
export const NEWS = "120363000000000002@newsletter"
export const LABEL = "main"

/** The second the fixture's clock starts at: 2026-11-07T05:00:00Z. */
const START_MS = Date.UTC(2026, 10, 7, 5, 0, 0)

/** The time `n` seconds after the start, in milliseconds. */
export const at = (n: number) => START_MS + n * MS_PER_SECOND

const ZERO_TIME = "0001-01-01T00:00:00Z"

/** A chat as `wacli chats list` prints it. */
export function wacliChat(init: Record<string, unknown> & { jid: string }): Record<string, unknown> {
  return {
    kind: "dm",
    name: "",
    last_message_ts: ZERO_TIME,
    archived: false,
    pinned: false,
    muted_until: 0,
    unread: false,
    unread_count: 0,
    ...init,
  }
}

/** What a test says of a message; the rest of the row is what wacli prints for an unremarkable one. */
export type MessageInit = Record<string, unknown> & { id: string; chat?: string; at: number }

/**
 * A message as `wacli messages list` prints it, paths included (which the tool must never pass on). `at` is the
 * time in milliseconds, written in whole seconds.
 */
export function wacliMessage({ id, chat = ALICE, at: when, ...rest }: MessageInit): Record<string, unknown> {
  const text = typeof rest.Text === "string" ? rest.Text : ""
  return {
    ChatJID: chat,
    ChatName: "",
    MsgID: id,
    SenderJID: rest.FromMe === true ? "15550100000@s.whatsapp.net" : chat.endsWith("@g.us") ? BOB : chat,
    SenderName: "",
    Timestamp: new Date(Math.floor(when / MS_PER_SECOND) * MS_PER_SECOND).toISOString().replace(".000Z", "Z"),
    FromMe: false,
    Text: text,
    DisplayText: text === "" ? "(message)" : text,
    IsForwarded: false,
    ReactionToID: "",
    ReactionEmoji: "",
    MediaType: "",
    MediaCaption: "",
    Filename: "",
    MimeType: "",
    DirectPath: "/v/t62.7118-24/private-direct-path",
    LocalPath: "/Users/someone/wacli/media/private-local-path",
    Starred: false,
    Edited: false,
    Revoked: false,
    DeletedForMe: false,
    DeliveredTo: 0,
    ReadBy: 0,
    Snippet: "",
    ...rest,
  }
}

/** One tool call's surroundings: a paired label, a fake wacli with a mirror a test fills, and the tool. */
export type ChatFixture = {
  fake: FakeWacli
  stateDir: string
  /** The mirror the fake reads from; `sync` publishes a change to it. */
  mirror: Required<Omit<FakeMirror, "relevance">> & Pick<FakeMirror, "relevance">
  /** Adds chats to the mirror. */
  addChats(...chats: Record<string, unknown>[]): void
  /** Adds messages to the mirror, in the order they arrive. */
  add(...messages: MessageInit[]): void
  /** Publishes `mirror` to the fake. */
  sync(): void
  /** Runs the tool and returns its result. */
  read(args: unknown): Promise<ChatReadOutput>
  /** Runs the tool and returns the error it throws. */
  failure(args: unknown): Promise<ToolError>
  /** Every page of a `view` of `chat`, following `next`. */
  pages(chat: string, args?: Record<string, unknown>): Promise<ChatReadOutput[]>
  /** The ids of the messages of every page, oldest first within a page, pages in the order read. */
  ids(pages: ChatReadOutput[]): string[]
  close(): Promise<void>
}

/** Sets up a paired label `main` with a fake wacli on `PATH`; call `close` afterwards. */
export async function createChatFixture(): Promise<ChatFixture> {
  const stateDir = await shortTempDir()
  mkdirSync(labelPaths(stateDir, LABEL).dir)
  const fake = await installFakeWacli()
  const originalPath = process.env.PATH
  process.env.PATH = fake.env.PATH
  resetWacliCache()
  const mirror: ChatFixture["mirror"] = { chats: [], messages: [], polls: [], calls: [] }
  const sync = () => fake.setMirror(mirror)
  sync()

  const read = (args: unknown) => invoke(whatsappChatRead, args, { cwd: stateDir, stateDir })
  const failure = async (args: unknown) => {
    try {
      await read(args)
    } catch (error) {
      if (error instanceof ToolError) return error
      throw error
    }
    throw new Error("expected the call to fail")
  }
  return {
    fake,
    stateDir,
    mirror,
    addChats(...chats) {
      mirror.chats.push(...chats)
      sync()
    },
    add(...messages) {
      mirror.messages.push(...messages.map(wacliMessage))
      sync()
    },
    sync,
    read,
    failure,
    async pages(chat, args = {}) {
      const pages: ChatReadOutput[] = []
      let cursor: string | undefined
      do {
        const page = await read({ method: "view", chat, ...args, ...(cursor ? { cursor } : {}) })
        pages.push(page)
        cursor = page.next
      } while (cursor)
      return pages
    },
    ids: (pages) => pages.flatMap((page) => (page.messages ?? []).map((message) => message.id)),
    async close() {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      resetWacliCache()
      await fake.cleanup()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}
