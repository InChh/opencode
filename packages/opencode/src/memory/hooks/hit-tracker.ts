import { HookChain } from "@/session/hooks"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Memory } from "../memory"
import { MemoryInject } from "../engine/injector"

const log = Log.create({ service: "memory.hooks.hit-tracker" })

/**
 * Register the post-tool memory hit tracker.
 *
 * Priority 210: runs after tool output truncation.
 *
 * Compares generated tool output against injected memories to detect
 * which memories actually influenced the response. Increments hitCount
 * for matching memories.
 */
export function registerHitTracker(): void {
  HookChain.register("memory-hit-tracker", "post-tool", 210, async (ctx) => {
    const config = await Config.get()
    if (config.memory?.enabled === false) return

    // Only track hits for code-generating tools
    const trackableTools = new Set([
      "write",
      "edit",
      "create",
      "bash",
      "multi_edit",
    ])
    if (!trackableTools.has(ctx.toolName)) return

    const cached = MemoryInject.getCachedRecall(ctx.sessionID)
    if (!cached || cached.relevant.length === 0) return

    const output = ctx.result.output.toLowerCase()

    // Check if any recalled memory content appears in the tool output
    const allMemories = await Memory.list()
    const relevantMemories = allMemories.filter((m) => cached.relevant.includes(m.id))

    for (const memory of relevantMemories) {
      // Simple keyword matching: check if significant words from memory appear in output
      const keywords = extractKeywords(memory.content)
      const matchCount = keywords.filter((kw) => output.includes(kw)).length
      const matchRatio = keywords.length > 0 ? matchCount / keywords.length : 0

      if (matchRatio >= 0.3) {
        await Memory.incrementHitCount(memory.id)
        log.info("memory hit detected", {
          memoryID: memory.id,
          toolName: ctx.toolName,
          matchRatio: Math.round(matchRatio * 100) + "%",
        })
      }
    }
  })
}

/**
 * Extract significant keywords from memory content for matching.
 * Filters out common stop words and short tokens.
 */
function extractKeywords(content: string): string[] {
  const STOP_WORDS = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "can",
    "shall",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "and",
    "but",
    "or",
    "nor",
    "not",
    "so",
    "yet",
    "both",
    "either",
    "neither",
    "each",
    "every",
    "all",
    "any",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "only",
    "own",
    "same",
    "than",
    "too",
    "very",
    "just",
    "because",
    "if",
    "when",
    "use",
    "using",
    "used",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
  ])

  return content
    .toLowerCase()
    .split(/[\s,.:;!?()[\]{}"'`]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
}
