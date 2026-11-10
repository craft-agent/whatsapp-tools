import type { Translations } from "../../words"

/** The English words and templates the chat archive tool writes in its approval prompt; the chat fact it shares is the message tools'. */
export const ARCHIVE_WORDS = {
  title: "Archive a chat",
  intent: "About to archive or unarchive a chat",
  archiveHeadline: "About to archive {chat}",
  unarchiveHeadline: "About to unarchive {chat}",
} as const

/** The English words and templates the chat pin tool writes in its approval prompt. */
export const PIN_WORDS = {
  title: "Pin a chat",
  intent: "About to pin or unpin a chat",
  pinHeadline: "About to pin {chat}",
  unpinHeadline: "About to unpin {chat}",
} as const

/** The English words and templates the chat mute tool writes in its approval prompt. */
export const MUTE_WORDS = {
  title: "Mute a chat",
  intent: "About to mute or unmute a chat",
  muteHeadline: "About to mute {chat}",
  unmuteHeadline: "About to unmute {chat}",
  forLabel: "For",
  eightHours: "8 hours",
  oneWeek: "1 week",
  always: "Always",
} as const

/** The translations of the chat state tools' words. */
export const CHAT_STATE_TRANSLATIONS: Translations = {
  ja: {
    [ARCHIVE_WORDS.title]: "チャットをアーカイブする",
    [ARCHIVE_WORDS.intent]: "チャットのアーカイブを切り替えようとしています",
    [ARCHIVE_WORDS.archiveHeadline]: "{chat} をアーカイブしようとしています",
    [ARCHIVE_WORDS.unarchiveHeadline]: "{chat} のアーカイブを解除しようとしています",
    [PIN_WORDS.title]: "チャットをピン留めする",
    [PIN_WORDS.intent]: "チャットのピン留めを切り替えようとしています",
    [PIN_WORDS.pinHeadline]: "{chat} をピン留めしようとしています",
    [PIN_WORDS.unpinHeadline]: "{chat} のピン留めを解除しようとしています",
    [MUTE_WORDS.title]: "チャットをミュートする",
    [MUTE_WORDS.intent]: "チャットのミュートを切り替えようとしています",
    [MUTE_WORDS.muteHeadline]: "{chat} をミュートしようとしています",
    [MUTE_WORDS.unmuteHeadline]: "{chat} のミュートを解除しようとしています",
    [MUTE_WORDS.forLabel]: "期間",
    [MUTE_WORDS.eightHours]: "8 時間",
    [MUTE_WORDS.oneWeek]: "1 週間",
    [MUTE_WORDS.always]: "常に",
  },
}
