import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Memory } from "../memory"
import { MemoryHindsightClient } from "./client"
import { MemoryHindsightMap } from "./mapper"

export namespace MemoryHindsightRecall {
  const log = Log.create({ service: "memory.hindsight.recall" })

  type Raw = Exclude<Awaited<ReturnType<typeof MemoryHindsightClient.recall>>, undefined>
  type Hit = {
    document_id?: string | null
    metadata?: Record<string, unknown> | null
    score?: unknown
    relevance_score?: unknown
    relevanceScore?: unknown
  }

  export interface Candidate {
    memory: Memory.Info
    memory_id: string
    document_id?: string
    rank: number
    score?: number
    reason: "document_id" | "metadata"
  }

  export interface Drop {
    memory_id?: string
    document_id?: string
    kind?: "mem" | "sess" | "obs"
    rank: number
    score?: number
    reason: MemoryHindsightMap.Resolve["reason"] | "stale" | "indirect"
  }

  export interface Result {
    raw: Raw
    hits: number
    candidates: Candidate[]
    drops: Drop[]
  }

  function hits(raw: Raw): Hit[] {
    const data = raw as unknown as { results?: unknown; items?: unknown }
    if (Array.isArray(data.results)) {
      return data.results as Hit[]
    }
    if (Array.isArray(data.items)) {
      return data.items as Hit[]
    }
    return []
  }

  function score(hit: Hit) {
    const value = [hit.score, hit.relevance_score, hit.relevanceScore].find((item) => typeof item === "number")
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }

  export async function query(input: {
    query: string
    pool: Memory.Info[]
    root?: string
  }): Promise<Result | undefined> {
    const cfg = await Config.get()
    if (!cfg.memory?.hindsight.enabled || !cfg.memory.hindsight.recall) return
    const raw = await MemoryHindsightClient.recall({ query: input.query })
    if (!raw) return

    const list = hits(raw)
    const root = input.root ?? Instance.worktree
    const pool = new Map(input.pool.map((memory) => [memory.id, memory]))
    const seen = new Set<string>()
    const candidates: Candidate[] = []
    const drops: Drop[] = []

    list.forEach((hit, index) => {
      const rank = index + 1
      const resolved = MemoryHindsightMap.resolve(hit, root)
      const item = {
        memory_id: resolved.memory_id,
        document_id: resolved.document_id,
        kind: resolved.kind,
        rank,
        score: score(hit),
      }

      if (!resolved.direct) {
        drops.push({
          ...item,
          reason: resolved.reason === "document_id" ? "indirect" : resolved.reason,
        })
        return
      }

      if (!resolved.memory_id) {
        drops.push({
          ...item,
          reason: resolved.reason,
        })
        return
      }

      const memory = pool.get(resolved.memory_id)
      if (!memory) {
        drops.push({
          ...item,
          reason: "stale",
        })
        return
      }

      if (seen.has(resolved.memory_id)) return
      seen.add(resolved.memory_id)
      candidates.push({
        memory,
        memory_id: resolved.memory_id,
        document_id: resolved.document_id,
        rank,
        score: item.score,
        reason: resolved.reason === "metadata" ? "metadata" : "document_id",
      })
    })

    log.info("hindsight recall resolved", {
      hits: list.length,
      resolved: candidates.length,
      dropped: drops.length,
      stale: drops.filter((item) => item.reason === "stale").length,
      indirect: drops.filter((item) => item.reason === "indirect").length,
    })

    return {
      raw,
      hits: list.length,
      candidates,
      drops,
    }
  }
}
