import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Memory } from "../memory"
import { load, inject_sections } from "../prompt/loader"
import { render } from "../prompt/template"
import { ConfigPaths } from "@/config/paths"
import { Instance } from "@/project/instance"

export namespace MemoryInject {
  const log = Log.create({ service: "memory.injector" })

  const DEFAULT_INJECT_POOL_LIMIT = 200
  const RECALL_THRESHOLD = 3
  const RE_RECALL_INTERVAL = 5

  // --- Recall cache ---

  interface CachedRecall {
    relevant: string[]
    conflicts: Array<{ memoryA: string; memoryB: string; reason: string }>
    userMessageCount: number
  }

  const recallCache = new Map<string, CachedRecall>()

  /**
   * Build the candidate pool: manual memories in full + auto memories by score up to limit.
   */
  export function buildCandidatePool(allMemories: Memory.Info[]): Memory.Info[] {
    const config = getPoolLimit()
    const manual = allMemories.filter((m) => m.inject || m.source.method === "manual" || m.source.method === "pulled")
    const auto = allMemories.filter((m) => !m.inject && m.source.method !== "manual" && m.source.method !== "pulled")

    const autoSlots = Math.max(0, config - manual.length)
    const topAuto = auto.sort((a, b) => b.score - a.score).slice(0, autoSlots)

    return [...manual, ...topAuto]
  }

  /**
   * Determine the injection phase based on user message count.
   */
  export function getPhase(userMessageCount: number): "full" | "recall" {
    return userMessageCount < RECALL_THRESHOLD ? "full" : "recall"
  }

  /**
   * Check if we should re-invoke the recall agent.
   */
  export function shouldReRecall(sessionID: string, currentUserMessageCount: number): boolean {
    const cached = recallCache.get(sessionID)
    if (!cached) return true
    if (currentUserMessageCount - cached.userMessageCount >= RE_RECALL_INTERVAL) return true
    if (Memory.isDirty(sessionID)) return true
    return false
  }

  /**
   * Store recall results in cache.
   */
  export function cacheRecallResult(
    sessionID: string,
    result: { relevant: string[]; conflicts: CachedRecall["conflicts"] },
    userMessageCount: number,
  ): void {
    recallCache.set(sessionID, {
      ...result,
      userMessageCount,
    })
    Memory.clearDirty(sessionID)
  }

  /**
   * Get cached recall result for a session.
   */
  export function getCachedRecall(sessionID: string): CachedRecall | undefined {
    return recallCache.get(sessionID)
  }

  /**
   * Clear recall cache for a session (e.g., on session end).
   */
  export function clearCache(sessionID: string): void {
    recallCache.delete(sessionID)
  }

  /**
   * Format memories for injection into system prompt.
   */
  export function formatMemoriesForPrompt(memories: Memory.Info[]): string {
    if (memories.length === 0) return ""

    const lines = memories.map((m) => {
      const scopeTag = m.scope === "team" ? "[team] " : ""
      const tagStr = m.tags.length > 0 ? ` (${m.tags.join(", ")})` : ""
      return `- [${m.category}] ${scopeTag}${m.content}${tagStr}`
    })

    return [
      "<memory>",
      "The following are your memories about this codebase and user preferences.",
      "Use them to inform your responses, but do not mention them explicitly unless asked.",
      "",
      ...lines,
      "</memory>",
    ].join("\n")
  }

  /**
   * Format conflict warnings for system prompt.
   */
  export function formatConflictWarning(
    conflicts: Array<{ memoryA: string; memoryB: string; reason: string }>,
  ): string {
    if (conflicts.length === 0) return ""

    const lines = conflicts.map((c) => `- Conflict between [${c.memoryA}] and [${c.memoryB}]: ${c.reason}`)

    return [
      "<memory-conflicts>",
      "Warning: The following memory conflicts were detected. Ask the user to resolve them.",
      "",
      ...lines,
      "</memory-conflicts>",
    ].join("\n")
  }

  /**
   * Format memories for injection using template loader (async version).
   */
  export async function formatMemoriesAsync(memories: Memory.Info[]): Promise<string> {
    if (memories.length === 0) return ""

    const tpl = await load("inject", await ConfigPaths.directories(Instance.directory, Instance.worktree))
    const parts = inject_sections(tpl)

    const lines = memories.map((m) => {
      const scopeTag = m.scope === "team" ? "[team] " : ""
      const tagStr = m.tags.length > 0 ? ` (${m.tags.join(", ")})` : ""
      return `- [${m.category}] ${scopeTag}${m.content}${tagStr}`
    })

    return render(parts.injection, { MEMORY_ITEMS: lines.join("\n") })
  }

  /**
   * Format conflict warnings using template loader (async version).
   */
  export async function formatConflictAsync(
    conflicts: Array<{ memoryA: string; memoryB: string; reason: string }>,
  ): Promise<string> {
    if (conflicts.length === 0) return ""

    const tpl = await load("inject", await ConfigPaths.directories(Instance.directory, Instance.worktree))
    const parts = inject_sections(tpl)

    const lines = conflicts.map((c) => `- Conflict between [${c.memoryA}] and [${c.memoryB}]: ${c.reason}`)

    return render(parts.conflict, { CONFLICT_ITEMS: lines.join("\n") })
  }

  /**
   * Count user messages in the message history.
   */
  export function countUserMessages(messages: unknown[]): number {
    return messages.filter((m: any) => m.role === "user").length
  }

  function getPoolLimit(): number {
    // Sync access not available, use default — caller should pass config if needed
    return DEFAULT_INJECT_POOL_LIMIT
  }
}
