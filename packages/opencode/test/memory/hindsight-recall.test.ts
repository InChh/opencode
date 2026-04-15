import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import type { Memory } from "../../src/memory/memory"
import { MemoryHindsightBank } from "../../src/memory/hindsight/bank"
import { MemoryHindsightClient } from "../../src/memory/hindsight/client"
import { MemoryHindsightRecall } from "../../src/memory/hindsight/recall"
import { tmpdir } from "../fixture/fixture"

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
  })

  test("returns undefined when hindsight recall is disabled or unavailable", async () => {
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
  })
})
