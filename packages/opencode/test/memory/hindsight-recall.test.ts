import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import type { Memory } from "../../src/memory/memory"
import { MemoryHindsightBank } from "../../src/memory/hindsight/bank"
import { MemoryHindsightClient } from "../../src/memory/hindsight/client"
import { MemoryHindsightRecall } from "../../src/memory/hindsight/recall"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

await Log.init({ print: false })

async function logs(at = 0) {
  await new Promise((resolve) => setTimeout(resolve, 10))
  return (
    await Bun.file(Log.file())
      .text()
      .catch(() => "")
  ).slice(at)
}

async function mark() {
  return (
    await Bun.file(Log.file())
      .text()
      .catch(() => "")
  ).length
}

type Hindsight = {
  enabled: boolean
  mode: "embedded"
  extract: boolean
  recall: boolean
  backfill: boolean
  workspace_scope: "worktree"
  context_max_items: number
  context_max_tokens: number
}

function cfg(input: Partial<Hindsight> = {}) {
  return {
    enabled: true,
    mode: "embedded" as const,
    extract: true,
    recall: true,
    backfill: true,
    workspace_scope: "worktree" as const,
    context_max_items: 6,
    context_max_tokens: 1200,
    ...input,
  }
}

function mem(id: string): Memory.Info {
  const now = Date.now()
  return {
    id,
    content: `memory ${id}`,
    categories: ["context"],
    scope: "personal",
    status: "confirmed",
    tags: [],
    citations: [],
    score: 1,
    baseScore: 1,
    useCount: 0,
    hitCount: 0,
    source: { sessionID: "sess_1", method: "manual" },
    createdAt: now,
    updatedAt: now,
    inject: false,
  }
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("MemoryHindsightRecall", () => {
  test("resolves ranked authoritative candidates and drops non-authoritative hits", async () => {
    const at = await mark()
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(),
        },
      },
    })

    const hash = MemoryHindsightBank.worktreeHash(tmp.path)
    const other = MemoryHindsightBank.worktreeHash("/tmp/opencode/other")
    const spy = spyOn(MemoryHindsightClient, "recall").mockResolvedValue({
      results: [
        {
          document_id: `mem:${hash}:mem_2`,
          metadata: { memory_id: "ignored" },
          score: 0.99,
        },
        {
          document_id: `sess:${hash}:sess_1:0:10`,
          score: 0.93,
        },
        {
          document_id: "external-doc",
          metadata: { memory_id: "mem_1", workspace_id: hash },
          relevance_score: 0.87,
        },
        {
          document_id: `mem:${other}:mem_3`,
          score: 0.7,
        },
        {
          document_id: `mem:${hash}:mem_missing`,
          score: 0.6,
        },
        {
          document_id: "unknown-doc",
          metadata: {},
          score: 0.5,
        },
        {
          document_id: `mem:${hash}:mem_2`,
          score: 0.4,
        },
      ],
    } as unknown as Awaited<ReturnType<typeof MemoryHindsightClient.recall>>)

    const result = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        MemoryHindsightRecall.query({
          query: "alpha beta",
          pool: [mem("mem_1"), mem("mem_2")],
        }),
    })

    expect(spy).toHaveBeenCalledWith({ query: "alpha beta" })
    expect(result).toBeDefined()
    expect(result?.hits).toBe(7)
    expect(
      result?.candidates.map((item) => ({
        memory_id: item.memory_id,
        rank: item.rank,
        score: item.score,
        reason: item.reason,
      })),
    ).toEqual([
      { memory_id: "mem_2", rank: 1, score: 0.99, reason: "document_id" },
      { memory_id: "mem_1", rank: 3, score: 0.87, reason: "metadata" },
    ])
    expect(result?.drops).toEqual([
      {
        document_id: `sess:${hash}:sess_1:0:10`,
        kind: "sess",
        memory_id: undefined,
        rank: 2,
        reason: "indirect",
        score: 0.93,
      },
      {
        document_id: `mem:${other}:mem_3`,
        kind: "mem",
        memory_id: undefined,
        rank: 4,
        reason: "cross_worktree",
        score: 0.7,
      },
      {
        document_id: `mem:${hash}:mem_missing`,
        kind: "mem",
        memory_id: "mem_missing",
        rank: 5,
        reason: "stale",
        score: 0.6,
      },
      {
        document_id: "unknown-doc",
        kind: undefined,
        memory_id: undefined,
        rank: 6,
        reason: "unresolved",
        score: 0.5,
      },
    ])
    const text = await logs(at)
    expect(text).toContain("hindsight recall query completed")
    expect(text).toContain("resolved=2")
    expect(text).toContain("stale=1")
    expect(text).toContain("indirect=1")
    expect(text).toContain("cross_worktree=1")
    expect(text).toContain("unresolved=1")
    expect(text).toContain("duration=")
  })

  test("returns undefined when hindsight recall is disabled or unavailable", async () => {
    const at = await mark()
    await using off = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg({ recall: false }),
        },
      },
    })

    const spy = spyOn(MemoryHindsightClient, "recall").mockResolvedValue(undefined)

    const disabled = await Instance.provide({
      directory: off.path,
      fn: () => MemoryHindsightRecall.query({ query: "alpha", pool: [mem("mem_1")] }),
    })

    expect(disabled).toBeUndefined()
    spy.mockClear()

    await using on = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg(),
        },
      },
    })

    const missing = await Instance.provide({
      directory: on.path,
      fn: () => MemoryHindsightRecall.query({ query: "alpha", pool: [mem("mem_1")] }),
    })

    expect(missing).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    const text = await logs(at)
    expect(text).toContain("hindsight recall query unavailable")
    expect(text).toContain("fallback=local")
    expect(text).toContain("reason=client_unavailable")
  })

  test("builds extractor context from source facts, chunks, and direct hit text", async () => {
    const at = await mark()
    await using tmp = await tmpdir({
      git: true,
      config: {
        memory: {
          hindsight: cfg({ extract: true }),
        },
      },
    })

    const spy = spyOn(MemoryHindsightClient, "recall").mockResolvedValue({
      results: [
        {
          document_id: `obs:${MemoryHindsightBank.worktreeHash(tmp.path)}:sess_1:abc`,
          score: 0.91,
          source_facts: [
            { id: "fact_1", document_id: "obs_1", text: "Observation from a related session" },
            { id: "fact_1", document_id: "obs_1", text: "Observation from a related session" },
          ],
        },
        {
          document_id: `sess:${MemoryHindsightBank.worktreeHash(tmp.path)}:sess_1:0:2`,
          relevance_score: 0.82,
          chunks: [{ id: "chunk_1", document_id: "doc_1", text: "Chunk from a retained document" }],
        },
        {
          document_id: `mem:${MemoryHindsightBank.worktreeHash(tmp.path)}:mem_1`,
          score: 0.73,
          text: "Direct fallback hit text",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof MemoryHindsightClient.recall>>)

    const result = await Instance.provide({
      directory: tmp.path,
      fn: () => MemoryHindsightRecall.context({ query: "extract hints" }),
    })

    expect(spy).toHaveBeenCalledWith({
      query: "extract hints",
      include_source_facts: true,
      include_chunks: true,
      max_source_facts_tokens: 1200,
      max_chunk_tokens: 1200,
    })
    expect(result?.hits).toBe(3)
    expect(result?.items).toEqual([
      { text: "Observation from a related session", kind: "obs", id: "obs_1", score: 0.91 },
      { text: "Chunk from a retained document", kind: "doc", id: "doc_1", score: 0.82 },
      {
        text: "Direct fallback hit text",
        kind: "doc",
        id: `mem:${MemoryHindsightBank.worktreeHash(tmp.path)}:mem_1`,
        score: 0.73,
      },
    ])
    const text = await logs(at)
    expect(text).toContain("hindsight extract assist ready")
    expect(text).toContain("hits=3")
    expect(text).toContain("items=3")
    expect(text).toContain("duration=")
  })
})
