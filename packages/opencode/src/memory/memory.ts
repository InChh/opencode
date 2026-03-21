import z from "zod"
import { Identifier } from "@/id/id"
import { Log } from "@/util/log"
import { MemoryStorage } from "./storage"

export namespace Memory {
  const log = Log.create({ service: "memory" })

  // --- Enums ---

  export const Category = z.enum([
    "style",
    "pattern",
    "tool",
    "domain",
    "workflow",
    "correction",
    "context",
  ])
  export type Category = z.infer<typeof Category>

  export const Scope = z.enum([
    "personal",
    "team",
  ])
  export type Scope = z.infer<typeof Scope>

  export const Status = z.enum([
    "pending",
    "confirmed",
  ])
  export type Status = z.infer<typeof Status>

  // --- Team Memory multi-dimension isolation ---

  export const TeamScope = z.object({
    global: z.boolean().default(false),
    projectIds: z.array(z.string()).default([]),
    languages: z.array(z.string()).default([]),
    techStack: z.array(z.string()).default([]),
    modules: z.array(z.string()).default([]),
  })
  export type TeamScope = z.infer<typeof TeamScope>

  // --- Source traceability ---

  export const Source = z.object({
    sessionID: z.string(),
    llmLogID: z.string().optional(),
    messageID: z.string().optional(),
    method: z.enum(["auto", "manual", "promoted", "pulled"]),
    contextSnapshot: z.string().optional(),
  })
  export type Source = z.infer<typeof Source>

  // --- Core data model ---

  export const Info = z.object({
    id: z.string(),
    content: z.string(),
    category: Category,
    scope: Scope,
    status: Status.default("confirmed"),
    tags: z.array(z.string()).default([]),
    source: Source,
    citations: z.array(z.string()).default([]),

    // lifecycle
    score: z.number().default(1.0),
    useCount: z.number().default(0),
    hitCount: z.number().default(0),
    lastUsedAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    confirmedAt: z.number().optional(),
    expiresAt: z.number().optional(),

    // injection control
    inject: z.boolean().default(false),

    // team promotion
    teamCandidateAt: z.number().optional(),
    teamSubmittedAt: z.number().optional(),
    teamApprovedAt: z.number().optional(),
    promotedBy: z.string().optional(),

    // team scope (only for scope === "team")
    teamScope: TeamScope.optional(),
  })
  export type Info = z.infer<typeof Info>

  // --- Create input (partial, system fills defaults) ---

  export const CreateInput = Info.omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  }).partial({
    score: true,
    useCount: true,
    hitCount: true,
    status: true,
    tags: true,
    citations: true,
  })
  export type CreateInput = z.infer<typeof CreateInput>

  // --- CRUD operations ---

  export async function create(input: CreateInput): Promise<Info> {
    const now = Date.now()
    const memory: Info = {
      ...input,
      id: Identifier.ascending("memory"),
      tags: input.tags ?? [],
      citations: input.citations ?? [],
      score: input.score ?? 1.0,
      useCount: input.useCount ?? 0,
      hitCount: input.hitCount ?? 0,
      status: input.status ?? "confirmed",
      createdAt: now,
      updatedAt: now,
    }
    const validated = Info.parse(memory)
    await MemoryStorage.save(validated)
    log.info("created", { id: validated.id, category: validated.category, scope: validated.scope })
    return validated
  }

  export async function get(id: string): Promise<Info | undefined> {
    return MemoryStorage.get(id)
  }

  export async function update(id: string, patch: Partial<Omit<Info, "id" | "createdAt">>): Promise<Info | undefined> {
    const existing = await MemoryStorage.get(id)
    if (!existing) return undefined
    const updated: Info = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    }
    const validated = Info.parse(updated)
    await MemoryStorage.save(validated)
    log.info("updated", { id })
    return validated
  }

  export async function remove(id: string): Promise<boolean> {
    const result = await MemoryStorage.remove(id)
    if (result) log.info("removed", { id })
    return result
  }

  export async function list(filter?: {
    scope?: Scope
    status?: Status
    category?: Category
    method?: Source["method"]
  }): Promise<Info[]> {
    const all = await MemoryStorage.loadAll()
    return all.filter((m) => {
      if (filter?.scope && m.scope !== filter.scope) return false
      if (filter?.status && m.status !== filter.status) return false
      if (filter?.category && m.category !== filter.category) return false
      if (filter?.method && m.source.method !== filter.method) return false
      return true
    })
  }

  export async function upsert(memory: Info): Promise<Info> {
    const validated = Info.parse({ ...memory, updatedAt: Date.now() })
    await MemoryStorage.save(validated)
    log.info("upserted", { id: validated.id })
    return validated
  }

  export async function findSimilar(content: string): Promise<Info | undefined> {
    const all = await MemoryStorage.loadAll()
    const normalized = content.toLowerCase().trim()
    return all.find((m) => m.content.toLowerCase().trim() === normalized)
  }

  // --- Meta key-value store (for tracking extraction state, etc.) ---

  export async function getMeta(key: string): Promise<number | undefined> {
    return MemoryStorage.getMeta(key)
  }

  export async function setMeta(key: string, value: number): Promise<void> {
    return MemoryStorage.setMeta(key, value)
  }

  // --- Counter helpers ---

  export async function incrementUseCount(id: string): Promise<void> {
    const memory = await get(id)
    if (!memory) return
    await update(id, {
      useCount: memory.useCount + 1,
      lastUsedAt: Date.now(),
    })
  }

  export async function incrementHitCount(id: string): Promise<void> {
    const memory = await get(id)
    if (!memory) return
    await update(id, { hitCount: memory.hitCount + 1 })
  }

  // --- Dirty tracking (for recall cache invalidation) ---

  const dirtySessionSet = new Set<string>()

  export function markDirty(sessionID: string): void {
    dirtySessionSet.add(sessionID)
  }

  export function isDirty(sessionID: string): boolean {
    return dirtySessionSet.has(sessionID)
  }

  export function clearDirty(sessionID: string): void {
    dirtySessionSet.delete(sessionID)
  }
}
