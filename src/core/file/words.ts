import type { Translations } from "../words"

/** The English words and templates the file save tool writes in its approval prompt. */
export const FILE_SAVE_WORDS = {
  title: "Save a message's file",
  intent: "About to save a received file",
  headline: "About to save {file} from {chat}",
  kindLabel: "Kind",
  image: "Image",
  video: "Video",
  audio: "Audio",
  document: "Document",
  sticker: "Sticker",
  fromLabel: "From",
  you: "You",
  unpackLabel: "Unpack",
  unpack: "If it is an archive",
} as const

/** The translations of the file save tool's words. */
export const FILE_SAVE_TRANSLATIONS: Translations = {
  ja: {
    [FILE_SAVE_WORDS.title]: "メッセージのファイルを保存する",
    [FILE_SAVE_WORDS.intent]: "受け取ったファイルを保存しようとしています",
    [FILE_SAVE_WORDS.headline]: "{chat} の {file} を保存しようとしています",
    [FILE_SAVE_WORDS.kindLabel]: "種類",
    [FILE_SAVE_WORDS.image]: "画像",
    [FILE_SAVE_WORDS.video]: "動画",
    [FILE_SAVE_WORDS.audio]: "音声",
    [FILE_SAVE_WORDS.document]: "ドキュメント",
    [FILE_SAVE_WORDS.sticker]: "スタンプ",
    [FILE_SAVE_WORDS.fromLabel]: "送信者",
    [FILE_SAVE_WORDS.you]: "自分",
    [FILE_SAVE_WORDS.unpackLabel]: "展開",
    [FILE_SAVE_WORDS.unpack]: "アーカイブなら行う",
  },
}
