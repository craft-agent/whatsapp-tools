import { messageKind, readKinds } from "../../chat/kinds"
import { openMirror, type Mirror } from "../../chat/mirror"
import type { WacliMessage } from "../../chat/rows"
import { ToolError } from "../../errors"
import { HISTORY_WORDS } from "../../history/words"
import { formatLocalTime } from "../../time"
import { confirmWrite, defineTool, type CallValue, type ToolContext } from "../../tool"
import { MESSAGE_DELETE_DEADLINE_MS, MESSAGE_DELETE_OP, deleteAnswer, type DeleteAnswer } from "../../whatsapp/delete"
import { pickLabel, type LabelPaths } from "../../whatsapp/labels"
import { callService } from "../../whatsapp/service-client"
import { openPromptMirror, promptTime } from "../describe"
import { checkedChat, deliveryFailure, messageIdOf } from "../recipient"
import { actionChat, actionMessage, actionTargets, ownMessage, type ActionChat } from "../target"
import { MESSAGE_WORDS } from "../words"
import {
  DELETE_NOTE,
  DELETE_WINDOW,
  DELETE_WINDOW_MS,
  input,
  output,
  type MessageDeleteInput,
  type MessageDeleteOutput,
} from "./schema"
import { DELETE_WORDS } from "./words"

const TOOL_ID = "whatsapp_message_delete"

const WRITE_CLASS = "administrative"

const UNCERTAIN_DELETE =
  "The deletion may have gone out. Read the chat with whatsapp_chat_read before deleting again; never repeat it on your own."

const NOT_DELETABLE = "A call cannot be deleted. Nothing was deleted."

/** The arguments of a call as far as they can be checked without the mirror. */
type DeleteRequest = { chat: string; id: string }

/** What the mirror says of the call: the chat's name and fact, and the message that would be deleted. */
type DeleteTarget = ActionChat & { row: WacliMessage }

function requestOf(args: MessageDeleteInput): DeleteRequest {
  return { chat: checkedChat(args.chat, TOOL_ID), id: messageIdOf(args.id, "id") }
}

/** Reads the mirror for the chat and the message, and refuses what the deletion would be refused for; `forbidden` past the window. */
async function targetOf(mirror: Mirror, { chat, id }: DeleteRequest): Promise<DeleteTarget> {
  const described = await actionChat(mirror, chat)
  const row = await actionMessage(mirror, chat, id)
  ownMessage(row, DELETE_WINDOW_MS, DELETE_WINDOW)
  if (messageKind(row, await readKinds(mirror, chat, [row])) === "call") {
    throw new ToolError("invalid_argument", NOT_DELETABLE)
  }
  return { ...described, row }
}

/** The `Message` fact's value: the user's own text, else the caption, else the kind of the message, which has no text to show. */
function messageValue(row: WacliMessage): CallValue | string {
  if (row.Text.trim() !== "") return row.Text
  if (row.MediaCaption.trim() !== "") return row.MediaCaption
  return { text: DELETE_WORDS.noText, values: { kind: row.MediaType || row.DisplayText } }
}

/** What the confirmation form says: which message goes, in which chat by its JID, and that it cannot be undone. The form escapes nothing, so neither the text nor the chat's name, which other people wrote, is shown. */
function confirmationOf({ row }: DeleteTarget, chat: string): string {
  const sent = promptTime(Date.parse(row.Timestamp))
  return `Delete your message sent ${sent} in chat ${chat} for everyone? Everyone in the chat sees it as deleted, and it cannot be undone.`
}

/** The sync service's answer to the deletion, with `uncertain` told in the tool's words. */
async function requestDeletion(paths: LabelPaths, request: DeleteRequest, ctx: ToolContext): Promise<DeleteAnswer> {
  let data: unknown
  try {
    data = await callService(paths, MESSAGE_DELETE_OP, request, {
      mode: "write",
      timeoutMs: MESSAGE_DELETE_DEADLINE_MS,
      signal: ctx.signal,
    })
  } catch (error) {
    throw deliveryFailure(error, "deletion", UNCERTAIN_DELETE)
  }
  const answer = deleteAnswer.safeParse(data)
  if (!answer.success) throw new ToolError("uncertain", UNCERTAIN_DELETE, { cause: answer.error })
  return answer.data
}

/** The `whatsapp_message_delete` tool definition. */
export const whatsappMessageDelete = defineTool({
  id: TOOL_ID,
  title: DELETE_WORDS.title,
  intent: DELETE_WORDS.intent,
  description: [
    `Deletes for everyone a message the user sent in a person's or a group's chat, of any kind but a call, at most ${DELETE_WINDOW} after it was sent (WhatsApp's limit); other people's messages cannot be deleted.`,
    "It cannot be undone.",
    "`chat` and `id` are as whatsapp_chat_read gives them.",
    "It needs the account's sync service running: the service pauses syncing for the call, a few seconds, then syncs again (`service_running` says whether it did).",
    "The result means WhatsApp accepted the deletion, not that it was delivered.",
    "A failure `uncertain` means the deletion may have gone out: read the chat with whatsapp_chat_read before deleting again.",
    "`errors.record` says when the deletion was accepted but could not be written to the mirror.",
    "Only when the user asked to delete this very message.",
  ].join(" "),
  toolset: "actions",
  class: WRITE_CLASS,
  input,
  output,
  targets: actionTargets(TOOL_ID),
  async describe(args, ctx) {
    const request = requestOf(args)
    const mirror = await openPromptMirror(ctx, args.account)
    const { name, fact, row } = await targetOf(mirror, request)
    return {
      headline: { text: DELETE_WORDS.headline, values: { chat: name } },
      facts: [
        fact,
        { label: MESSAGE_WORDS.sentLabel, value: promptTime(Date.parse(row.Timestamp)) },
        { label: MESSAGE_WORDS.textLabel, value: messageValue(row) },
        { label: HISTORY_WORDS.syncLabel, value: { text: DELETE_WORDS.syncPaused } },
      ],
    }
  },
  async execute(args, ctx): Promise<MessageDeleteOutput> {
    const request = requestOf(args)
    const stateDir = ctx.stateDir
    if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
    const paths = await pickLabel(stateDir, args.account)

    const target = await targetOf(openMirror(paths, ctx.signal), request)
    await confirmWrite({ id: TOOL_ID, class: WRITE_CLASS }, ctx, confirmationOf(target, request.chat))
    const accepted = await requestDeletion(paths, request, ctx)
    return {
      chat: request.chat,
      id: request.id,
      deleted: true,
      time: formatLocalTime(accepted.accepted_ms),
      service_running: accepted.service_running,
      ...(accepted.store_warning === undefined ? {} : { errors: { record: accepted.store_warning } }),
      note: DELETE_NOTE,
    }
  },
})
