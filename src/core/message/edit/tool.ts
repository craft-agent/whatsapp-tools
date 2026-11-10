import { messageKind, readKinds } from "../../chat/kinds"
import { openMirror, type Mirror } from "../../chat/mirror"
import type { WacliMessage } from "../../chat/rows"
import { ToolError } from "../../errors"
import { ANY_TARGET } from "../../targets"
import { formatLocalTime } from "../../time"
import { defineTool, type ToolContext } from "../../tool"
import { MESSAGE_EDIT_DEADLINE_MS, MESSAGE_EDIT_OP, editAnswer, type EditAnswer } from "../../whatsapp/edit"
import { labelTargets } from "../../whatsapp/label-targets"
import { pickLabel, type LabelPaths } from "../../whatsapp/labels"
import { MESSAGE_TEXT_MAX_CHARACTERS } from "../../whatsapp/send"
import { callService } from "../../whatsapp/service-client"
import { promptTime, openPromptMirror } from "../describe"
import { checkedChat, checkedText, chatOf, deliveryFailure, messageIdOf, type TextRules } from "../recipient"
import { actionChat, actionMessage, ownMessage, type ActionChat } from "../target"
import {
  EDIT_NOTE,
  EDIT_WINDOW,
  EDIT_WINDOW_MS,
  input,
  output,
  type MessageEditInput,
  type MessageEditOutput,
} from "./schema"
import { EDIT_WORDS } from "./words"

const TOOL_ID = "whatsapp_message_edit"

/** What a new text is checked against: the length one message takes, and the words for a text over it. */
const TEXT_RULES: TextRules = {
  maxCharacters: MESSAGE_TEXT_MAX_CHARACTERS,
  tooLong: (length) =>
    `text is ${length} characters and one message takes at most ${MESSAGE_TEXT_MAX_CHARACTERS}. Never shorten it yourself; ask the user how to cut it. Nothing was changed.`,
}

const UNCERTAIN_EDIT =
  "The edit may have gone out. Read the chat with whatsapp_chat_read before editing again; never repeat it on your own."

const NOT_TEXT = "Only text messages can be edited: a photo, a file, a poll or a call cannot. Nothing was changed."

const SAME_TEXT = "The new text is the same as the current one, so there is nothing to edit. Nothing was changed."

/** The arguments of a call as far as they can be checked without the mirror. */
type EditRequest = { chat: string; id: string; text: string }

/** What the mirror says of the call: the chat's name and fact, and the message that would be edited. */
type EditTarget = ActionChat & { row: WacliMessage }

function requestOf(args: MessageEditInput): EditRequest {
  return {
    chat: checkedChat(args.chat, TOOL_ID),
    text: checkedText(args.text, TEXT_RULES),
    id: messageIdOf(args.id, "id"),
  }
}

/** Refuses a message that is not plain text: media, a poll, a vote or a call. */
async function requireText(mirror: Mirror, chat: string, row: WacliMessage): Promise<void> {
  if (row.MediaType !== "" || row.Text === "") throw new ToolError("invalid_argument", NOT_TEXT)
  if (messageKind(row, await readKinds(mirror, chat, [row])) !== undefined) {
    throw new ToolError("invalid_argument", NOT_TEXT)
  }
}

/** Reads the mirror for the chat and the message, and refuses what the edit would be refused for; `forbidden` past the window. */
async function targetOf(mirror: Mirror, { chat, id, text }: EditRequest): Promise<EditTarget> {
  const described = await actionChat(mirror, chat)
  const row = await actionMessage(mirror, chat, id)
  ownMessage(row, EDIT_WINDOW_MS, EDIT_WINDOW)
  await requireText(mirror, chat, row)
  if (text === row.Text.trim()) throw new ToolError("invalid_argument", SAME_TEXT)
  return { ...described, row }
}

/** The sync service's answer to the edit, with `uncertain` told in the tool's words. */
async function requestEdit(paths: LabelPaths, request: EditRequest, ctx: ToolContext): Promise<EditAnswer> {
  let data: unknown
  try {
    data = await callService(paths, MESSAGE_EDIT_OP, request, {
      mode: "write",
      timeoutMs: MESSAGE_EDIT_DEADLINE_MS,
      signal: ctx.signal,
    })
  } catch (error) {
    throw deliveryFailure(error, "edit", UNCERTAIN_EDIT)
  }
  const answer = editAnswer.safeParse(data)
  if (!answer.success) throw new ToolError("uncertain", UNCERTAIN_EDIT, { cause: answer.error })
  return answer.data
}

/** What the call writes to: the account and the chat, or `*` when either cannot be told. */
async function editTargets(args: MessageEditInput, ctx: ToolContext): Promise<string[]> {
  let chat: string
  try {
    chat = chatOf(args.chat, TOOL_ID)
  } catch {
    return [ANY_TARGET]
  }
  return labelTargets(ctx, args.account, chat)
}

/** The `whatsapp_message_edit` tool definition. */
export const whatsappMessageEdit = defineTool({
  id: TOOL_ID,
  title: EDIT_WORDS.title,
  intent: EDIT_WORDS.intent,
  description: [
    `Edits the text of a message the user sent in a person's or a group's chat, at most ${EDIT_WINDOW} after it was sent (WhatsApp's limit); only text messages can be edited, and other people's messages cannot.`,
    "`chat` and `id` are as whatsapp_chat_read gives them.",
    "It needs the account's sync service running.",
    `\`text\` is the new text exactly as given, surrounding blank space trimmed, at most ${MESSAGE_TEXT_MAX_CHARACTERS} characters.`,
    "The people in the chat see the message marked as edited, and the earlier text is gone from it.",
    "The result means WhatsApp accepted the edit, not that it was delivered or seen.",
    "A failure `uncertain` means the edit may have gone out: read the chat with whatsapp_chat_read before editing again.",
    "`errors.record` says when the edit was accepted but could not be written to the mirror.",
    "Only when the user asked for this edit.",
  ].join(" "),
  toolset: "actions",
  class: "overwrite",
  input,
  output,
  targets: editTargets,
  async describe(args, ctx) {
    const request = requestOf(args)
    const mirror = await openPromptMirror(ctx, args.account)
    const { name, fact, row } = await targetOf(mirror, request)
    return {
      headline: { text: EDIT_WORDS.headline, values: { chat: name } },
      facts: [
        fact,
        { label: EDIT_WORDS.sentLabel, value: promptTime(Date.parse(row.Timestamp)) },
        { label: EDIT_WORDS.currentLabel, value: row.Text },
      ],
      text: { label: EDIT_WORDS.textLabel, body: request.text },
    }
  },
  async execute(args, ctx): Promise<MessageEditOutput> {
    const request = requestOf(args)
    const stateDir = ctx.stateDir
    if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
    const paths = await pickLabel(stateDir, args.account)

    await targetOf(openMirror(paths, ctx.signal), request)
    const accepted = await requestEdit(paths, request, ctx)
    return {
      chat: request.chat,
      id: request.id,
      time: formatLocalTime(accepted.accepted_ms),
      ...(accepted.store_warning === undefined ? {} : { errors: { record: accepted.store_warning } }),
      note: EDIT_NOTE,
    }
  },
})
