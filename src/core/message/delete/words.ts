import type { Translations } from "../../words"

/** The English words and templates the message delete tool writes in its approval prompt; the chat, sent-time, message and sync facts' labels it shares are the message and history tools'. */
export const DELETE_WORDS = {
  title: "Delete a message for everyone",
  intent: "About to delete a message for everyone",
  headline: "About to delete your message in {chat} for everyone",
  noText: "{kind} with no text",
  syncPaused: "Paused for the call",
} as const

/** The translations of the message delete tool's words. */
export const DELETE_TRANSLATIONS: Translations = {
  ja: {
    [DELETE_WORDS.title]: "メッセージを全員から削除する",
    [DELETE_WORDS.intent]: "メッセージを全員から削除しようとしています",
    [DELETE_WORDS.headline]: "{chat} の自分のメッセージを全員から削除しようとしています",
    [DELETE_WORDS.noText]: "テキストのない{kind}",
    [DELETE_WORDS.syncPaused]: "この操作の間だけ一時停止",
  },
}
