import { Config } from "@/config/config"
import { Log } from "@/util/log"
import { Memory } from "../memory"

export namespace MemoryDecay {
  const log = Log.create({ service: "memory.decay" })

  const DEFAULT_HALF_LIFE = 30
  const DEFAULT_INJECT_POOL_LIMIT = 200

  /**
   * Calculate effective score with exponential decay.
   *
   * Formula: score * decayFactor * usageFactor * hitFactor
   *   - decayFactor = 0.5 ^ (daysSinceUse / halfLife)
   *   - usageFactor = min(2.0, 1.0 + useCount * 0.1)
   *   - hitFactor = 1.0 + hitRate * 0.5
   */
  export function calculateDecay(memory: Memory.Info, halfLife?: number): number {
    const effectiveHalfLife = halfLife ?? DEFAULT_HALF_LIFE
    const now = Date.now()
    const daysSinceUse = memory.lastUsedAt
      ? (now - memory.lastUsedAt) / (1000 * 60 * 60 * 24)
      : (now - memory.createdAt) / (1000 * 60 * 60 * 24)

    const decayFactor = Math.pow(0.5, daysSinceUse / effectiveHalfLife)
    const usageFactor = Math.min(2.0, 1.0 + memory.useCount * 0.1)
    const hitRate = memory.useCount > 0 ? memory.hitCount / memory.useCount : 0
    const hitFactor = 1.0 + hitRate * 0.5

    return memory.score * decayFactor * usageFactor * hitFactor
  }

  /**
   * Run decay update for all personal memories and check inject pool capacity.
   *
   * - Updates effective scores for all memories
   * - Returns pool usage info for capacity monitoring
   */
  export async function maintain(): Promise<MaintainResult> {
    const config = await Config.get()
    const halfLife = config.memory?.decayHalfLife ?? DEFAULT_HALF_LIFE
    const poolLimit = config.memory?.injectPoolLimit ?? DEFAULT_INJECT_POOL_LIMIT

    const memories = await Memory.list({ scope: "personal" })

    // 1. Update decay scores
    for (const memory of memories) {
      const effectiveScore = calculateDecay(memory, halfLife)
      if (Math.abs(effectiveScore - memory.score) > 0.01) {
        await Memory.update(memory.id, { score: effectiveScore })
      }
    }

    // 2. Calculate inject pool usage
    // Pool = manual (inject: true) + top-N by score
    const manualCount = memories.filter((m) => m.inject).length
    const autoSlots = Math.max(0, poolLimit - manualCount)
    const autoPool = memories
      .filter((m) => !m.inject)
      .sort((a, b) => b.score - a.score)
      .slice(0, autoSlots)
    const poolSize = manualCount + autoPool.length
    const usage = poolLimit > 0 ? poolSize / poolLimit : 0

    if (usage > 0.9) {
      log.warn("inject pool near capacity", { poolSize, poolLimit, usage: Math.round(usage * 100) + "%" })
    }

    return { totalMemories: memories.length, poolSize, poolLimit, usage }
  }

  export interface MaintainResult {
    totalMemories: number
    poolSize: number
    poolLimit: number
    usage: number
  }
}
