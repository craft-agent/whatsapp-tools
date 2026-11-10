import type { Translations } from "../../words"

/** The English words and templates the message edit tool writes in its approval prompt; the chat and sent-time facts it shares are the message tools'. */
export const EDIT_WORDS = {
  title: "Edit a message",
  intent: "About to edit a message",
  headline: "About to edit your message in {chat}",
  currentLabel: "Current",
  textLabel: "New text",
} as const

/** The translations of the message edit tool's words. */
export const EDIT_TRANSLATIONS: Translations = {
  ja: {
    [EDIT_WORDS.title]: "メッセージを編集する",
    [EDIT_WORDS.intent]: "メッセージを編集しようとしています",
    [EDIT_WORDS.headline]: "{chat} の自分のメッセージを編集しようとしています",
    [EDIT_WORDS.currentLabel]: "現在の文面",
    [EDIT_WORDS.textLabel]: "新しい文面",
  },
}
