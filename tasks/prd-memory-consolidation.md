# PRD: Memory Consolidation — Automatic Optimization of Memory Count

## Introduction

The memory system accumulates entries over time through auto-extraction, manual saves, and recovery scans. There is no mechanism to reduce count: no deduplication, no pruning of dead entries, no merging of similar content. The only "cleanup" is score decay, which lowers scores but never removes anything.

This feature adds three layers of consolidation to keep memory lean and high-quality:

1. **Heuristic pruning** (zero LLM cost) — dedup, expire, prune low-score entries
2. **Scheduler-driven consolidation** — periodic background checks with configurable intervals
3. **Provider balance-aware triggering** — query real provider credit balance (e.g. OpenRouter `/api/v1/auth/key`) and opportunistically run consolidation when spare credits are detected near billing reset

The guiding principle is **奥卡姆剃刀 (Occam's Razor)**: extend existing mechanisms (`optimizer-hook.ts`, `Scheduler`, `MemoryDecay.maintain()`) rather than introducing new agents or abstractions. No new `memory-consolidator` agent — all LLM-level consolidation is deferred to a future phase.

## Goals

- Reduce memory count by automatically removing duplicates, expired, and low-value entries
- Prevent unbounded memory growth without manual intervention
- Opportunistically trigger consolidation using spare provider credits before billing reset
- Keep heuristic consolidation at zero LLM cost
- Auto-execute safe operations (dedup, expire); require confirmation for destructive LLM operations (future phase)
- Observable: log all consolidation actions with counts and reasons

## User Stories

### US-001: Heuristic Deduplication in Daily Maintenance

**Description:** As a user, I want duplicate memories to be automatically merged so that my memory pool stays clean without manual effort.

**Acceptance Criteria:**

- [ ] During daily maintenance (`optimizer-hook.ts`), after decay, scan all personal memories for near-duplicate pairs using `findSimilar()` logic with configurable Jaccard threshold (default ≥ 0.8)
- [ ] For each duplicate group: keep the entry with higher `score`, merge `useCount`, `hitCount`, `tags` (union, deduplicated), and `categories` (union, deduplicated) from removed entries into the kept entry, then delete the duplicates
- [ ] Dedup runs across category boundaries — comparison ignores `categories`; merged entry gets `categories = union(all.categories)`
- [ ] Dedup threshold configurable via `config.memory.consolidation.similarity` (default: 0.8)
- [ ] Log each merge: `{ kept: id, removed: [ids], reason: "dedup", similarity: number }`
- [ ] Publish a new `MemoryEvent.Consolidated` event with summary `{ deduped: number, expired: number, pruned: number }`
- [ ] Typecheck passes

### US-002: Expired Memory Cleanup

**Description:** As a user, I want memories with a past `expiresAt` to be automatically removed so stale knowledge doesn't pollute my context.

**Acceptance Criteria:**

- [ ] During daily maintenance, delete all memories where `expiresAt` is set and `expiresAt < Date.now()`
- [ ] Log each removal: `{ id, reason: "expired", expiresAt }`
- [ ] Count included in `MemoryEvent.Consolidated` event
- [ ] Typecheck passes

### US-003: Low-Score Pruning

**Description:** As a user, I want memories that have decayed to near-zero and were never used to be automatically removed so the pool doesn't fill with dead entries.

**Acceptance Criteria:**

- [ ] During daily maintenance, after decay score update, delete memories matching ALL of: `score < 0.1`, `useCount === 0`, `hitCount === 0`, age > 60 days
- [ ] Do NOT prune memories with `inject: true` (manually pinned), `status: "confirmed"` with `hitCount > 0`, or `categories` containing `"correction"` (correction memories are exempt from pruning regardless of score)
- [ ] Log each removal: `{ id, reason: "low-score", score, age }`
- [ ] Count included in `MemoryEvent.Consolidated` event
- [ ] Configurable via `config.memory.consolidation.prune_threshold` (default: 0.1) and `config.memory.consolidation.prune_age` (default: 60)
- [ ] Typecheck passes

### US-004: Consolidated Event and Maintenance Result

**Description:** As a developer, I want a single event summarizing all consolidation actions so downstream systems (UI, log viewer) can display consolidation activity.

**Acceptance Criteria:**

- [ ] Define `MemoryEvent.Consolidated` in `event.ts` with schema: `{ deduped: number, expired: number, pruned: number, total_removed: number }`
- [ ] Published once at end of daily maintenance if `total_removed > 0`
- [ ] `MemoryDecay.maintain()` return type extended with consolidation counts
- [ ] Typecheck passes

### US-005: Unified Consolidation Trigger via Scheduler

**Description:** As a user, I want consolidation to have multiple trigger points (session creation, scheduler tick) but be rate-limited to run at most once per scheduler interval, so idle periods are utilized without excessive execution.

**Acceptance Criteria:**

- [ ] Register a Scheduler task `"memory-consolidation"` with scope `"instance"` and configurable interval (default: 4 hours)
- [ ] The Scheduler task is the **sole executor** of consolidation logic (dedup + expire + prune)
- [ ] Rate-limited via a single shared meta key `Memory.getMeta("lastConsolidateAt")` — skip if last run was within `consolidation.interval`
- [ ] The existing `optimizer-hook.ts` (session.created) **no longer runs consolidation directly**. Instead, it only ensures the Scheduler task is registered (idempotent). The optimizer hook continues to run decay, confirmation, and team-candidate detection independently
- [ ] Multiple trigger points (session creation, scheduler tick, future idle hook) all converge on the same Scheduler task with the same rate limit — at most one execution per interval regardless of how many triggers fire
- [ ] Controlled by `config.memory.consolidation.enabled` (default: `true` when `memory.enabled` is true)
- [ ] Controlled by `config.memory.consolidation.interval` (default: `14400000` = 4 hours in ms)
- [ ] Typecheck passes

### US-006: Provider Balance Query

**Description:** As a developer, I need a generic interface to query the user's remaining credit balance from their LLM provider, so the consolidation scheduler can make budget-aware decisions.

**Acceptance Criteria:**

- [ ] Add `Provider.balance(providerID: string): Promise<{ credits: number, unit: string } | undefined>` that returns remaining credits or `undefined` if the provider doesn't support balance queries
- [ ] Implement for OpenRouter: `GET https://openrouter.ai/api/v1/auth/key` with the user's API key → parse `data.usage` and `data.limit` → return `{ credits: limit - usage, unit: "usd" }`
- [ ] Return `undefined` for providers without a balance API (Anthropic, OpenAI, Bedrock, etc.)
- [ ] Cache the result for 10 minutes to avoid excessive API calls (simple in-memory cache with TTL)
- [ ] Typecheck passes

### US-007: Balance-Aware Consolidation Trigger

**Description:** As a user with a subscription that resets monthly, I want the system to automatically detect spare credits near billing reset and use them for memory consolidation, so I get value from tokens I'd otherwise lose.

**Acceptance Criteria:**

- [ ] In the Scheduler task from US-005, after heuristic consolidation, check provider balance via `Provider.balance()`
- [ ] If balance is available AND `credits > config.memory.consolidation.min_spare_credits` (default: 0.50 USD) AND today is within `config.memory.consolidation.days_before_reset` days of the configured reset day (default: 3 days before `reset_day`): log `"spare credits detected, consolidation eligible"` — this prepares for future LLM-based consolidation
- [ ] For now (Phase 1): only log the opportunity and publish `MemoryEvent.ConsolidationEligible` event. Actual LLM consolidation is out of scope
- [ ] Config fields: `config.memory.consolidation.reset_day` (1-28, default: 1), `config.memory.consolidation.min_spare_credits` (default: 0.50), `config.memory.consolidation.days_before_reset` (default: 3)
- [ ] Typecheck passes

### US-008: Config Schema for Consolidation

**Description:** As a user, I want to configure consolidation behavior through the standard config file.

**Acceptance Criteria:**

- [ ] Add `consolidation` section to `config.memory` schema in `config.ts`:
  ```
  consolidation: {
    enabled: boolean          // default: true
    interval: number          // ms, default: 14400000 (4h)
    similarity: number        // Jaccard threshold for dedup, default: 0.8
    prune_threshold: number   // min score to keep, default: 0.1
    prune_age: number         // min age in days before pruning, default: 60
    reset_day: number         // 1-28, billing reset day, default: 1
    days_before_reset: number // default: 3
    min_spare_credits: number // USD, default: 0.50
  }
  ```
- [ ] All fields optional with sensible defaults
- [ ] Existing `config.memory.autoOptimize: false` also disables consolidation
- [ ] Typecheck passes

## Functional Requirements

- FR-1: Deduplication uses configurable Jaccard similarity threshold (`consolidation.similarity`, default 0.8, stricter than `findSimilar`'s 0.6) to avoid false positives in automated deletion
- FR-2: When merging duplicates, the kept entry receives: `useCount += sum(removed.useCount)`, `hitCount += sum(removed.hitCount)`, `lastUsedAt = max(all.lastUsedAt)`, `tags = union(all.tags)`, `categories = union(all.categories)` (all deduplicated). Its `content` and `baseScore` are preserved as-is
- FR-3: Pruning never removes memories with `inject: true` (user-pinned)
- FR-4: Pruning never removes memories with `scope: "team"` (shared memories are not locally deletable)
- FR-5: Pruning never removes memories whose `categories` includes `"correction"` — correction memories are exempt regardless of score, because deleting them may cause LLM to repeat past mistakes
- FR-6: All removal operations use `Memory.batchRemove()` for atomic persistence
- FR-7: Consolidation is idempotent — running twice in a row produces no changes on the second run
- FR-8: `Provider.balance()` uses a 10-minute in-memory TTL cache keyed by `providerID`
- FR-9: Balance query failures (network error, auth error) are logged and treated as `undefined` (no balance info) — never block consolidation
- FR-10: **Unified trigger**: consolidation has one executor (Scheduler task) with one rate-limit meta key (`lastConsolidateAt`). Multiple trigger points (session creation, scheduler interval, future idle event) all converge on this single execution path. At most one consolidation run per `consolidation.interval`
- FR-11: The Scheduler task runs immediately on registration (first tick) then every `interval` ms, matching existing Scheduler behavior
- FR-12: Consolidation failures in one step (e.g. dedup) do not block subsequent steps (e.g. expire, prune) — each step has independent try/catch

## Non-Goals

- No LLM-based consolidation (merge/rewrite via agent) — deferred to future phase
- No new `memory-consolidator` agent — follows Occam's Razor principle
- No UI for consolidation review — use existing `memory_list` / `memory_forget` tools
- No Anthropic/OpenAI/Bedrock balance API integration (they don't expose it)
- No automatic `expiresAt` assignment — users set this manually or via extractor
- No cross-project memory consolidation — each project's memory is independent

## Technical Considerations

### Prerequisite: Category Array Refactor

This PRD assumes the Appendix (Category Array Refactor) is **implemented first**. Dedup merges `categories` arrays directly — there is no fallback to single `category`. For memories not yet migrated, the Category Array migration normalizes `category → categories: [category]` on read, so consolidation always operates on arrays.

### Extending Existing Code (Not New Modules)

The consolidation logic should be added to existing files following Occam's Razor:

1. **`optimizer-hook.ts`** — Keep decay/confirmation/team-candidate as-is. Remove consolidation from this hook; it only ensures the Scheduler task is registered
2. **`decay.ts`** → rename or extend to `optimizer.ts` — Add `consolidate()` function alongside `maintain()`
3. **`event.ts`** — Add `Consolidated` and `ConsolidationEligible` events
4. **`provider.ts`** — Add `balance()` function
5. **`config.ts`** — Extend `memory` schema with `consolidation` sub-object
6. **`bootstrap.ts`** — Register the Scheduler task (sole consolidation executor)

### Unified Trigger Architecture

```
Trigger points (multiple):          Executor (single):
  session.created (optimizer-hook)
  scheduler tick (every 4h)     ──→  consolidate()
  future: session.idle event          │
                                      ├─ check lastConsolidateAt (skip if within interval)
                                      ├─ dedup
                                      ├─ expire
                                      ├─ prune
                                      └─ balance check (log only)
```

All triggers converge on the same `consolidate()` function with the same `lastConsolidateAt` rate limit. This ensures at most one run per interval regardless of trigger source.

### Dedup Algorithm Detail

```
1. Load all personal memories
2. Sort by score descending (keep highest-scored entry in each group)
3. For each memory (starting from lowest score):
   a. If already marked for removal, skip
   b. Find all remaining memories with Jaccard(this.content, other.content) >= similarity threshold
      (comparison is content-only, ignores categories)
   c. In the group, keep the one with highest score
   d. Mark others for removal, accumulate their useCount/hitCount/tags/categories
4. Batch remove all marked entries
5. Batch update kept entries with merged counts, tags (union), categories (union)
```

### Provider Balance API

OpenRouter exposes `GET /api/v1/auth/key`:

```json
{
  "data": {
    "label": "my-key",
    "usage": 1.234,      // USD spent
    "limit": 10.0,       // USD limit (null if unlimited)
    "is_free_tier": false,
    "rate_limit": { ... }
  }
}
```

Credits remaining = `limit - usage` (if `limit` is not null).

### Performance

- Memory count is bounded by `injectPoolLimit` (default 200) in practice, so O(n²) Jaccard comparison is fine (200² = 40K comparisons max)
- Balance API is cached 10 min — at most 6 calls/hour per provider
- Scheduler task is `unref()`'d — does not prevent process exit

## Success Metrics

- Memory count stabilizes or decreases over time instead of growing monotonically
- Zero false-positive deletions (tracked via consolidation logs)
- Consolidation runs complete in < 500ms for heuristic layer (no LLM cost)
- Provider balance detection works for OpenRouter users (most common subscription provider)

## Resolved Questions

1. **Tags merge strategy** → **Union (取并集去重)**. Merge all tags from removed entries into the kept entry, deduplicated. Preserves recall keywords.
2. **Cross-category dedup** → **Yes, cross category**. If Jaccard ≥ 0.8 across different categories, merge them and keep the winner's category. A separate PRD will explore changing `category` from single value to array.
3. **Future LLM consolidation prompt** → **Extend extractor prompt**. Add `merge`, `rewrite`, `delete` actions to the existing `memory-extractor` agent prompt. No new agent (Occam's Razor).
4. **Consolidation notification** → **Log only, no user notification**. Silent background operation. Results visible via log viewer.
5. **Execution order** → **Category Array Refactor (Appendix) 先发**, consolidation dedup 直接基于 `categories` 数组操作。单 category 的旧数据在读时已被 migration 归一化为 `[category]`，无需特殊处理。
6. **Dedup threshold** → **可配置**, `config.memory.consolidation.similarity` (default: 0.8)。命名语义化，表达"内容相似度"。
7. **Correction 类豁免** → **是**, `categories` 包含 `"correction"` 的 memory 豁免低分裁剪。Correction 记录纠正 LLM 错误行为，即使 score 低也不应删除。
8. **触发收敛** → **统一为单一执行路径**。Scheduler 任务是唯一执行者，共用 `lastConsolidateAt` meta key 做 rate limit。session.created / scheduler tick / 未来 idle hook 都是触发点，但每个 interval 周期内最多执行一次。

## Open Questions

_(None remaining — all resolved above.)_

---

# Appendix: Category Array Refactor

> This section is a self-contained mini-PRD for changing `Memory.Category` from a single enum value to an array. **This refactor should be implemented before the main Consolidation stories**, because consolidation dedup directly operates on `categories` arrays. Category array eliminates cross-category duplicate ambiguity.

## Introduction

Currently `Memory.Info.category` is a single enum string (`"style" | "pattern" | "tool" | "domain" | "workflow" | "correction" | "context"`). A memory can only belong to one category. In practice, knowledge often spans multiple categories — for example, "Prefer functional array methods over for loops" is both `style` and `pattern`. This forces the extractor to pick one, leading to cross-category duplicates and inconsistent recall filtering.

This refactor changes `category` to `categories` (an array), updates all consumers, and migrates existing data.

## Goals

- Allow a memory to belong to multiple categories simultaneously
- Eliminate cross-category duplication caused by single-category limitation
- Maintain backward compatibility during migration (read old format, write new format)
- Keep injection grouping behavior sensible (a memory appears under its primary/first category)

## Compatibility Risk Analysis

This is a **breaking change** that touches storage, APIs, SDK, tools, prompts, and tests. The table below classifies every touchpoint by risk level.

### 🔴 CRITICAL — External API / Storage (breaks consumers)

| File                             | Current Usage                                                                                                                  | Breaking Change                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory/storage.ts`              | `MemoryRecord.category: string` (line 15) — persisted to `personal.json` on disk                                               | Field rename in persistent JSON. Old files have `category`, new code expects `categories`. **Requires read-time migration**                               |
| `sdk/js/src/v2/gen/types.gen.ts` | 6 locations: `category: "style" \| ...` in event types and API responses (lines 958, 1001, 1051, 1124, 5548, 5562, 5631, 5672) | Auto-generated from Zod schemas — **SDK must be regenerated** (`./packages/sdk/js/script/build.ts`). External consumers' TypeScript will break on upgrade |
| `memory/web/api.ts`              | `GET /` query param `category`, `PUT /:id` body `category`, stats `breakdown[m.category]` (lines 45, 120, 129, 174)            | **HTTP API contract change**. Query param name changes or must accept both old/new. Response body field name changes                                      |

### 🟠 HIGH — Core Data Model

| File                         | Current Usage                                                                                                                                       | Change Required                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `memory/memory.ts`           | `Info.category: Category` (line 47), `list()` filter `m.category !== filter.category` (line 176), `CreateInput` uses `category`                     | Schema rename + filter logic rewrite                                          |
| `memory/engine/extractor.ts` | `ExtractedItem.category: Memory.Category` (line 26), `Memory.create({ category })` (line 231), `formatExisting()` uses `(${m.category})` (line 292) | LLM output schema change — extractor must parse both old and new format       |
| `memory/engine/injector.ts`  | `block()` groups by `m.category === category` (line 283)                                                                                            | Grouping logic change. The `order` array (line 16) iterates single categories |

### 🟡 MEDIUM — Internal Logic & Events

| File                                    | Current Usage                                                                                                                                                                      | Change Required                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `memory/engine/recall.ts`               | Passes `category: m.category` to recall LLM (line 85)                                                                                                                              | Rename field in prompt input                                         |
| `memory/hooks/optimizer-hook.ts`        | `memory.category === "correction"` guard (line 96)                                                                                                                                 | Change to `categories.includes("correction")`                        |
| `memory/event.ts`                       | Events carry `Memory.Info` which has `category` — consumed by Bus subscribers                                                                                                      | Payload shape change (downstream listeners must handle `categories`) |
| `test/memory/web-api.test.ts`           | `category: "tool"`, `category: "style"` in test data (lines 30, 38); filter assertions `list({ category: "tool" })` (line 72); stats breakdown `categoryBreakdown.tool` (line 190) | All test data and assertions must update                             |
| `test/memory/tools.test.ts`             | `category: "tool"` (line 27), `expect(m.category).toBe("tool")` (line 47), many more                                                                                               | All test data and assertions must update                             |
| `test/session/agent-request.test.ts`    | `Memory.Category.options.toContain(item.category)` (lines 255, 507)                                                                                                                | Validation logic change                                              |
| `test/session/hooks/ralph-loop.test.ts` | `category: "context"` in test helper (line 45)                                                                                                                                     | Test data update                                                     |

### 🟢 LOW — Display & Prompts

| File                                 | Current Usage                                                                                                                                              | Change Required              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `memory/tool/remember.ts`            | Param `category: Memory.Category` (line 46), display `Category: ${memory.category}` (line 62)                                                              | Param rename, display format |
| `memory/tool/memory-list.ts`         | Filter `category: args.category` (line 18), display `[${m.category}]` (line 36)                                                                            | Filter + display             |
| `memory/tool/forget.ts`              | Display `Forgot: ${memory.category}` (lines 32, 60), list `[${m.category}]` (line 67)                                                                      | Display only                 |
| `memory/web/app.html`                | `CategoryBadge` component (line 13), filter dropdown `filter.category` (line 179), badge display `<CategoryBadge category={m.category}/>` (lines 210, 261) | Multi-badge support          |
| `memory/prompt/default/extract.txt`  | `"category"` in LLM instructions (line 16 area)                                                                                                            | Wording update               |
| `memory/prompt/default/remember.txt` | `"category: One of ..."` (line 16)                                                                                                                         | Wording update               |
| `memory/prompt/default/recall.txt`   | `"each with: id, content, category, tags"` (line 10)                                                                                                       | Wording update               |

## Compatibility Strategy

The refactor must handle **4 compatibility boundaries**:

### 1. Storage Compatibility (personal.json on disk)

Users have existing `personal.json` files with `category: "style"`. After upgrade, the code expects `categories: ["style"]`.

**Strategy: Dual-field read, single-field write**

```
Read path:
  if record has "category" (string) and no "categories" → normalize to categories: [category]
  if record has "categories" (array) → use as-is
  if record has both → prefer "categories", ignore "category"

Write path:
  Always write "categories" array
  Delete legacy "category" field from the record before persist

Bootstrap migration:
  On first startup after upgrade, bulk-convert all records (guarded by meta key)
  This eliminates per-read normalization cost after first run
```

**Rollback safety**: If user downgrades to old version, old code reads `category` field which was deleted. To protect against this:

- During migration, keep `category` field as `categories[0]` for one version cycle (write both fields)
- Remove legacy `category` field in a subsequent release

### 2. SDK / API Compatibility (external consumers)

The JS SDK types are auto-generated from the OpenAPI spec (derived from Zod schemas). Changing `category → categories` is a breaking change for SDK consumers.

**Strategy: Versioned transition**

```
Phase A (this release):
  - Internal code uses "categories" everywhere
  - REST API accepts BOTH "category" (string) and "categories" (array) in query/body
  - REST API response includes BOTH fields: "category": categories[0], "categories": [...]
  - SDK regenerated with both fields (categories is primary, category is deprecated)

Phase B (next major):
  - Remove "category" from API responses
  - Remove backward compat from query/body parsing
  - SDK regenerated without "category"
```

### 3. LLM Prompt Compatibility (extractor / recall output)

LLMs may cache old prompts or follow old examples. The extractor prompt changes from `"category": "style"` to `"categories": ["style"]`.

**Strategy: Parse-time normalization**

```typescript
// In extractor.ts parse():
const item = raw.categories
  ? { ...raw, categories: raw.categories } // new format
  : { ...raw, categories: [raw.category] } // old format fallback

// ExtractedItem schema accepts both:
z.object({
  categories: z.array(Memory.Category).min(1).optional(),
  category: Memory.Category.optional(), // legacy
}).transform((r) => ({
  ...r,
  categories: r.categories ?? (r.category ? [r.category] : undefined),
}))
```

### 4. Tool Interface Compatibility (LLM tool calls)

The `memory_remember` tool currently has `category: Memory.Category`. LLMs in active sessions may still call with the old parameter.

**Strategy: Accept both parameter names**

```typescript
parameters: z.object({
  categories: z.array(Memory.Category).min(1).optional(),
  category: Memory.Category.optional(), // deprecated, backward compat
  // ...
}).refine((r) => r.categories || r.category, "categories or category required")
```

Internally normalize: `categories ?? (category ? [category] : undefined)`

## User Stories

### US-CAT-001: Schema Change — `category` → `categories`

**Description:** As a developer, I need the data model to support multiple categories per memory so that knowledge spanning multiple domains is correctly classified.

**Acceptance Criteria:**

- [ ] `Memory.Category` enum unchanged (still the 7 values)
- [ ] `Memory.Info`: field `category` replaced by `categories: z.array(Memory.Category).min(1)`
- [ ] `Memory.CreateInput` updated: `categories` is required, accepts array
- [ ] `MemoryRecord` in `storage.ts`: field `category: string` replaced by `categories: string[]`
- [ ] All TypeScript compilation errors from the rename are resolved across the codebase
- [ ] Typecheck passes

### US-CAT-002: Storage Migration & Backward Compat

**Description:** As a user with existing memories, I need my `personal.json` data to be seamlessly migrated so nothing breaks on upgrade — and if I downgrade, data is not lost.

**Acceptance Criteria:**

- [ ] Read-time normalization: `Memory.get()`, `Memory.list()`, and storage `loadAll()` normalize raw records — if `category` (string) exists and `categories` (array) does not, set `categories = [category]`
- [ ] Write-time: `MemoryStorage.save()` always writes `categories` array field. Also writes `category: categories[0]` as a **deprecated compatibility field** so that older code versions can still read the file
- [ ] Bulk migration function `migrateCategories()`: converts all records in `personal.json`, guarded by meta key `categoriesMigratedAt`
- [ ] Called during `InstanceBootstrap`, idempotent — running twice produces identical output
- [ ] Mixed-format resilience: if a record has both `category` and `categories`, prefer `categories`
- [ ] Typecheck passes

### US-CAT-003: SDK & REST API Backward Compat

**Description:** As an external SDK consumer, I need the API to continue working during the transition so my integration doesn't break on upgrade.

**Acceptance Criteria:**

- [ ] REST API `GET /` (list): accepts query param `category` (string, deprecated) **and** `categories` (string, comma-separated). Both filter by `categories.includes(value)`
- [ ] REST API `PUT /:id` (update): accepts body field `category` (string, deprecated) **and** `categories` (array). If both present, `categories` wins
- [ ] REST API response body: includes **both** `category: categories[0]` (deprecated) and `categories: [...]` for one version cycle
- [ ] REST API `GET /stats`: `categoryBreakdown` counts each memory once per category in its array
- [ ] SDK regenerated via `./packages/sdk/js/script/build.ts` — new types include both `category` (deprecated) and `categories`
- [ ] Typecheck passes

### US-CAT-004: Injection Grouping Update

**Description:** As a user, I want the `<memory>` block in system prompts to still be grouped by category, with multi-category memories appearing under their primary (first) category.

**Acceptance Criteria:**

- [ ] `injector.ts` `block()`: group by `categories[0]` (primary) — a memory appears in exactly one group
- [ ] Output format unchanged for single-category memories
- [ ] `order` array unchanged
- [ ] Typecheck passes

### US-CAT-005: Extractor & Recall Prompt Update

**Description:** As a developer, I need the LLM prompts to output `categories` arrays, with backward compat for old-format responses.

**Acceptance Criteria:**

- [ ] `ExtractedItem` schema: accepts both `categories` (array, primary) and `category` (string, legacy fallback). Zod `.transform()` normalizes to `categories`
- [ ] Extract prompt (`extract.txt`): instruct LLM to output `"categories": ["style", "pattern"]`
- [ ] Recall prompt (`recall.txt`): input format shows `categories` array
- [ ] Remember prompt (`remember.txt`): shows `categories` parameter
- [ ] `formatExisting()` updated: `- [id] (style, pattern) content`
- [ ] Typecheck passes

### US-CAT-006: Tool Interface Update

**Description:** As a user (or LLM calling tools), I want `memory_remember` / `memory_list` / `memory_forget` to support multi-category, with backward compat for old `category` parameter.

**Acceptance Criteria:**

- [ ] `memory_remember`: accepts `categories` (array, primary) **and** `category` (string, deprecated). Normalized internally
- [ ] `memory_list`: `category` filter param unchanged (single value) — matches any memory where `categories.includes(value)`
- [ ] `memory_list` display: `[style,pattern]` for multi-category, `[style]` for single
- [ ] `memory_forget` display: `Forgot: style,pattern`
- [ ] Typecheck passes

### US-CAT-007: Web UI Update

**Description:** As a user of the Memory Manager web UI, I want to see and filter by multiple categories.

**Acceptance Criteria:**

- [ ] `CategoryBadge` component renders multiple badges for multi-category memories
- [ ] Category filter dropdown unchanged (single select) — matches any category in the array
- [ ] Edit modal allows adding/removing categories (multi-select)
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-CAT-008: Optimizer & Team Candidate Compat

**Description:** As a developer, I need the optimizer hook's `category === "correction"` guard and team candidate logic to work with arrays.

**Acceptance Criteria:**

- [ ] `optimizer-hook.ts`: `memory.category === "correction"` → `memory.categories.includes("correction")`
- [ ] No other optimizer logic depends on category
- [ ] Typecheck passes

### US-CAT-009: Test Suite Update

**Description:** As a developer, I need all existing tests to pass after the category→categories migration.

**Acceptance Criteria:**

- [ ] `test/memory/web-api.test.ts`: all `category: "..."` in test data → `categories: ["..."]`; filter and stats assertions updated
- [ ] `test/memory/tools.test.ts`: all `category:` → `categories:`, all `m.category` assertions → `m.categories`
- [ ] `test/session/agent-request.test.ts`: `Category.options.toContain(item.category)` → validate against `categories` array
- [ ] `test/session/hooks/ralph-loop.test.ts`: test helper `category:` → `categories:`
- [ ] All tests pass: `bun test` in `packages/opencode`
- [ ] Typecheck passes

### US-CAT-010: Consolidation Dedup Alignment

**Description:** As a developer, I need the consolidation dedup logic (from the main PRD) to work correctly with multi-category memories.

**Acceptance Criteria:**

- [ ] Dedup merge: `categories = union(winner.categories, loser.categories)` (deduplicated)
- [ ] This replaces the previous "keep winner's category" behavior from the main PRD's FR-2
- [ ] Typecheck passes

## Functional Requirements

- FR-CAT-1: `categories` field is `z.array(Memory.Category).min(1)` — empty array is invalid
- FR-CAT-2: Primary category is `categories[0]` — used for injection grouping and display priority
- FR-CAT-3: Storage writes **both** `categories` (array) and `category` (string, = `categories[0]`) for one version cycle to support downgrade. Legacy `category` removal scheduled for next major
- FR-CAT-4: Read-time normalization: records with only `category` (string) are automatically converted to `categories: [category]`
- FR-CAT-5: LLM output compat: extractor parses both `category` (string) and `categories` (array), normalizes to array
- FR-CAT-6: Tool compat: `memory_remember` accepts both `category` (string) and `categories` (array) parameters
- FR-CAT-7: API compat: REST endpoints accept both field names in query/body; responses include both for one version cycle
- FR-CAT-8: Filter `list({ category: "style" })` matches any memory where `categories.includes("style")`
- FR-CAT-9: Team candidate check: `categories.includes("correction")` replaces `category === "correction"`
- FR-CAT-10: Stats breakdown: a memory in `["style", "pattern"]` increments both counters (total count unaffected)
- FR-CAT-11: SDK must be regenerated after schema change (`./packages/sdk/js/script/build.ts`)

## Non-Goals

- No category hierarchy or parent-child relationships
- No weighted categories (all categories in the array are equal except `[0]` is primary for display)
- No category auto-suggestion (LLM decides categories, user can edit)
- No migration CLI command — migration runs automatically on bootstrap
- No removal of deprecated `category` field in this release (scheduled for next major)

## Technical Considerations

### Migration Safety

The migration is designed to be safe and **reversible**:

1. **Read path**: Always normalizes `category → [category]` on load — works even without explicit migration
2. **Write path**: Writes **both** `categories` (primary) and `category` (compat) — old code that reads `category` still works after downgrade
3. **Bulk migration**: One-time pass converts all records on bootstrap, preventing repeated per-read normalization
4. **Rollback**: Old version reads `category` field which is still present — no data loss on downgrade
5. **Future cleanup**: Remove `category` field from write path in next major version

### Storage Format Transition

```json
// Old format (before migration)
{ "id": "mem_xxx", "category": "style", "content": "..." }

// Transition format (this release — both fields)
{ "id": "mem_xxx", "categories": ["style", "pattern"], "category": "style", "content": "..." }

// Final format (next major — category field removed)
{ "id": "mem_xxx", "categories": ["style", "pattern"], "content": "..." }
```

### Injection Dedup

With multi-category, a memory could theoretically appear in multiple `<memory>` block groups. To avoid duplication in the system prompt, only the primary category (`categories[0]`) determines grouping. This is a deliberate simplification.

### Implementation Order (Dependency Graph)

```
US-CAT-001 (Schema)
  ├→ US-CAT-002 (Storage migration)  — depends on new schema
  ├→ US-CAT-005 (Extractor/Recall)   — depends on new schema
  └→ US-CAT-008 (Optimizer)          — depends on new schema
       ├→ US-CAT-003 (SDK/API compat) — depends on schema + storage
       ├→ US-CAT-004 (Injector)       — depends on schema
       ├→ US-CAT-006 (Tools)          — depends on schema
       ├→ US-CAT-007 (Web UI)         — depends on API compat
       └→ US-CAT-009 (Tests)          — depends on all above
            └→ US-CAT-010 (Dedup alignment) — depends on tests passing
```

## Success Metrics

- Zero memories lose their category during migration
- Zero breakage on downgrade (deprecated `category` field preserved)
- SDK consumers can upgrade without immediate code changes (both fields present)
- Extractor produces multi-category memories when appropriate (observable in logs)
- All existing tests pass after migration
- No increase in duplicate memories across categories (the original motivation)
