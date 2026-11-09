import type { Translations } from "../words"

/** The English words and templates the message tools write in their approval prompts, and those of the chat and reply facts they share. */
export const MESSAGE_WORDS = {
  title: "Send a message",
  intent: "About to send a message",
  headline: "About to send a message to {chat}",
  chatLabel: "Chat",
  person: "Person",
  group: "Group",
  newPerson: "New person, number checked before sending",
  replyLabel: "Reply to",
  replyFrom: "{sender}, {time}",
  replyFromMe: "You, {time}",
  textLabel: "Message",
} as const

/** The translations of the message tools' words. */
export const MESSAGE_TRANSLATIONS: Translations = {
  ja: {
    [MESSAGE_WORDS.title]: "メッセージを送る",
    [MESSAGE_WORDS.intent]: "メッセージを送ろうとしています",
    [MESSAGE_WORDS.headline]: "{chat} にメッセージを送ろうとしています",
    [MESSAGE_WORDS.chatLabel]: "チャット",
    [MESSAGE_WORDS.person]: "個人",
    [MESSAGE_WORDS.group]: "グループ",
    [MESSAGE_WORDS.newPerson]: "新しい相手（送る前に番号を確認）",
    [MESSAGE_WORDS.replyLabel]: "返信先",
    [MESSAGE_WORDS.replyFrom]: "{sender}、{time}",
    [MESSAGE_WORDS.replyFromMe]: "自分、{time}",
    [MESSAGE_WORDS.textLabel]: "メッセージ",
  },
}
