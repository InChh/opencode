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
    text?: unknown
    content?: unknown
    original_text?: unknown
    source_facts?: unknown
    sourceFacts?: unknown
    chunks?: unknown
  }

  type Snippet = {
    id?: unknown
    document_id?: unknown
    text?: unknown
    content?: unknown
    original_text?: unknown
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

  export interface Context {
    text: string
    kind: "doc" | "obs"
    id?: string
    score?: number
  }

  export interface ContextResult {
    raw: Raw
    hits: number
    items: Context[]
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

  function text(value: unknown) {
    if (typeof value !== "string") return
    const result = value.replace(/\s+/g, " ").trim()
    return result || undefined
  }

  function id(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }

  function list(value: unknown) {
    return Array.isArray(value) ? (value as Snippet[]) : []
  }

  function snippets(items: Snippet[], kind: Context["kind"], rank?: number) {
    return items.flatMap((item) => {
      const value = text(item.text) ?? text(item.content) ?? text(item.original_text)
      if (!value) return []
      return [
        {
          text: value,
          kind,
          id: id(item.document_id) ?? id(item.id),
          score: rank,
        },
      ]
    })
  }

  function notes(hit: Hit): Context[] {
    const value = score(hit)
    const facts = snippets(list(hit.source_facts ?? hit.sourceFacts), "obs", value)
    if (facts.length > 0) return facts

    const chunks = snippets(list(hit.chunks), "doc", value)
    if (chunks.length > 0) return chunks

    const body = text(hit.text) ?? text(hit.content) ?? text(hit.original_text)
    if (!body) return []
    const doc = id(hit.document_id)
    return [
      {
        text: body,
        kind: doc?.startsWith("obs:") ? "obs" : "doc",
        id: doc,
        score: value,
      },
    ]
  }

  export async function query(input: {
    query: string
    pool: Memory.Info[]
    root?: string
  }): Promise<Result | undefined> {
    const cfg = await Config.get()
    if (!cfg.memory?.hindsight.enabled || !cfg.memory.hindsight.recall) return
    const at = Date.now()
    const raw = await MemoryHindsightClient.recall({ query: input.query })
    if (!raw) {
      log.warn("hindsight recall query unavailable", {
        query: input.query,
        duration: Date.now() - at,
        fallback: "local",
        reason: "client_unavailable",
      })
      return
    }

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

    log.info("hindsight recall query completed", {
      query: input.query,
      duration: Date.now() - at,
      hits: list.length,
      resolved: candidates.length,
      dropped: drops.length,
      stale: drops.filter((item) => item.reason === "stale").length,
      indirect: drops.filter((item) => item.reason === "indirect").length,
      cross_worktree: drops.filter((item) => item.reason === "cross_worktree").length,
      unresolved: drops.filter((item) => item.reason === "unresolved").length,
    })

    return {
      raw,
      hits: list.length,
      candidates,
      drops,
    }
  }

  export async function context(input: { query: string }): Promise<ContextResult | undefined> {
    const cfg = await Config.get()
    if (!cfg.memory?.hindsight.enabled || !cfg.memory.hindsight.extract) return
    const at = Date.now()
    const raw = await MemoryHindsightClient.recall({
      query: input.query,
      include_source_facts: true,
      include_chunks: true,
      max_source_facts_tokens: cfg.memory.hindsight.context_max_tokens,
      max_chunk_tokens: cfg.memory.hindsight.context_max_tokens,
    })
    if (!raw) {
      log.warn("hindsight extract assist unavailable", {
        query: input.query,
        duration: Date.now() - at,
        fallback: "prompt_only",
        reason: "client_unavailable",
      })
      return
    }

    const seen = new Set<string>()
    const items = hits(raw).flatMap((hit) =>
      notes(hit).filter((item) => {
        const key = `${item.kind}:${item.id ?? ""}:${item.text}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }),
    )

    log.info(items.length > 0 ? "hindsight extract assist ready" : "hindsight extract assist empty", {
      query: input.query,
      duration: Date.now() - at,
      hits: hits(raw).length,
      items: items.length,
      fallback: items.length > 0 ? undefined : "prompt_only",
      reason: items.length > 0 ? undefined : "no_usable_context",
    })

    return {
      raw,
      hits: hits(raw).length,
      items,
    }
  }
}
