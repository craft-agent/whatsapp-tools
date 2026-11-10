import type { Translations } from "../../words"

/** The English words and templates the message react tool writes in its approval prompt; the chat and sent-time facts it shares are the message tools'. */
export const REACT_WORDS = {
  title: "React to a message",
  intent: "About to react to a message",
  headline: "About to react with {emoji} in {chat}",
  removeHeadline: "About to remove your reaction in {chat}",
  fromLabel: "From",
  fromMe: "You",
} as const

/** The translations of the message react tool's words. */
export const REACT_TRANSLATIONS: Translations = {
  ja: {
    [REACT_WORDS.title]: "メッセージにリアクションする",
    [REACT_WORDS.intent]: "メッセージにリアクションしようとしています",
    [REACT_WORDS.headline]: "{chat} で {emoji} のリアクションを付けようとしています",
    [REACT_WORDS.removeHeadline]: "{chat} で自分のリアクションを外そうとしています",
    [REACT_WORDS.fromLabel]: "送信者",
    [REACT_WORDS.fromMe]: "自分",
  },
}
