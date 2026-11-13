import { formatLocalTime } from "../../time"
import { defineTool, type CallFact } from "../../tool"
import { CHAT_MUTE_OP, MUTE_DURATION_MS, type MuteChoice } from "../../whatsapp/chat-state"
import { openPromptMirror } from "../../message/describe"
import { checkedChat } from "../../message/recipient"
import { actionChat, actionGate, actionTargets } from "../../message/target"
import { openMirror } from "../mirror"
import { ACCEPTED_NOTE, muteInput, muteOutput, type ChatMuteOutput } from "./schema"
import { requestChange, statePaths } from "./state"
import { MUTE_WORDS } from "./words"

const TOOL_ID = "whatsapp_chat_mute"

/** The words that say how long each mute lasts. */
const MUTE_FOR: Record<Exclude<MuteChoice, "off">, string> = {
  "8_hours": MUTE_WORDS.eightHours,
  "1_week": MUTE_WORDS.oneWeek,
  always: MUTE_WORDS.always,
}

/** The `For` fact of a mute, or none for unmuting. */
function forFacts(mute: MuteChoice): CallFact[] {
  return mute === "off" ? [] : [{ label: MUTE_WORDS.forLabel, value: { text: MUTE_FOR[mute] } }]
}

/** When a mute set at `acceptedMs` ends, in local time, or undefined for one that does not end. */
function untilOf(mute: MuteChoice, acceptedMs: number): string | undefined {
  return mute === "8_hours" || mute === "1_week" ? formatLocalTime(acceptedMs + MUTE_DURATION_MS[mute]) : undefined
}

/** The `whatsapp_chat_mute` tool definition. */
export const whatsappChatMute = defineTool({
  id: TOOL_ID,
  title: MUTE_WORDS.title,
  intent: MUTE_WORDS.intent,
  description: [
    "Mutes a person's or a group's chat the mirror holds for 8 hours, a week or always, as the phone offers (`8_hours`, `1_week`, `always`), or unmutes it with `off`.",
    "`chat` is as whatsapp_chat_read list gives it.",
    "It needs the account's sync service running.",
    "Only the user's own devices show it; nobody in the chat learns of it.",
    "The result means WhatsApp accepted the change; `until` says when a timed mute ends.",
    "A failure `uncertain` means the change may have reached WhatsApp; it only sets a state, so calling again with the same arguments is safe.",
    "Only when the user asked for this change.",
  ].join(" "),
  toolset: "actions",
  class: "idempotent",
  input: muteInput,
  output: muteOutput,
  targets: actionTargets(TOOL_ID),
  gate: actionGate,
  async describe(args, ctx) {
    const chat = checkedChat(args.chat, TOOL_ID)
    const { name, fact } = await actionChat(await openPromptMirror(ctx, args.account), chat)
    return {
      headline: {
        text: args.mute === "off" ? MUTE_WORDS.unmuteHeadline : MUTE_WORDS.muteHeadline,
        values: { chat: name },
      },
      facts: [fact, ...forFacts(args.mute)],
    }
  },
  async execute(args, ctx): Promise<ChatMuteOutput> {
    const chat = checkedChat(args.chat, TOOL_ID)
    const paths = await statePaths(ctx, args.account)

    await actionChat(openMirror(paths, ctx.signal), chat)
    const accepted = await requestChange(paths, CHAT_MUTE_OP, { chat, mute: args.mute }, ctx)
    const until = untilOf(args.mute, accepted.accepted_ms)
    return {
      chat,
      mute: args.mute,
      ...(until === undefined ? {} : { until }),
      time: formatLocalTime(accepted.accepted_ms),
      note: ACCEPTED_NOTE,
    }
  },
})
