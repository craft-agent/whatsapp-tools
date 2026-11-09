import type { Translations } from "../../words"

/** The English words and templates the file send tool writes in its approval prompt; the chat and reply facts it shares are the message tools'. */
export const FILE_SEND_WORDS = {
  title: "Send files",
  intent: "About to send files",
  headlineOne: "About to send {file} to {chat}",
  headlineSeveral: "About to send files to {chat}",
  sentAsLabel: "Sent as",
  photo: "Photo",
  video: "Video",
  audio: "Audio",
  document: "Document",
  photos: "Photos",
  videos: "Videos",
  audioFiles: "Audio files",
  documents: "Documents",
  textLabel: "Caption",
} as const

/** The translations of the file send tool's words. */
export const FILE_SEND_TRANSLATIONS: Translations = {
  ja: {
    [FILE_SEND_WORDS.title]: "ファイルを送る",
    [FILE_SEND_WORDS.intent]: "ファイルを送ろうとしています",
    [FILE_SEND_WORDS.headlineOne]: "{chat} に {file} を送ろうとしています",
    [FILE_SEND_WORDS.headlineSeveral]: "{chat} にファイルを送ろうとしています",
    [FILE_SEND_WORDS.sentAsLabel]: "形式",
    [FILE_SEND_WORDS.photo]: "写真",
    [FILE_SEND_WORDS.video]: "動画",
    [FILE_SEND_WORDS.audio]: "音声",
    [FILE_SEND_WORDS.document]: "ドキュメント",
    [FILE_SEND_WORDS.photos]: "写真",
    [FILE_SEND_WORDS.videos]: "動画",
    [FILE_SEND_WORDS.audioFiles]: "音声",
    [FILE_SEND_WORDS.documents]: "ドキュメント",
    [FILE_SEND_WORDS.textLabel]: "キャプション",
  },
}
