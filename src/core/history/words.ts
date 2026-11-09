import type { Translations } from "../words"

/** The English words and templates the history tools write in their approval prompts. */
export const HISTORY_WORDS = {
  title: "Ask the phone for older messages",
  intent: "About to ask the phone for older messages",
  headline: "About to ask the phone for older messages of {chat}",
  syncLabel: "Sync",
  syncPause: "Paused for up to {minutes} minutes",
  batchesLabel: "Batches",
  oldestLabel: "Oldest held",
} as const

/** The translations of the history tools' words. */
export const HISTORY_TRANSLATIONS: Translations = {
  ja: {
    [HISTORY_WORDS.title]: "古いメッセージをスマートフォンに求める",
    [HISTORY_WORDS.intent]: "古いメッセージをスマートフォンに求めようとしています",
    [HISTORY_WORDS.headline]: "{chat} の古いメッセージをスマートフォンに求めようとしています",
    [HISTORY_WORDS.syncLabel]: "同期",
    [HISTORY_WORDS.syncPause]: "最大 {minutes} 分間一時停止",
    [HISTORY_WORDS.batchesLabel]: "バッチ数",
    [HISTORY_WORDS.oldestLabel]: "手元の最古",
  },
}
