# PRD: Hindsight Local Memory Integration

## Introduction

The current memory system is local, JSON-backed, and already owns memory lifecycle behavior such as status, score, use tracking, hit tracking, decay, confirmation, injection, and the memory manager UI. Recall quality is useful but limited because candidate selection still depends on the current local filter and the extractor only sees raw conversation plus existing memories.

This feature adds a **local embedded Hindsight companion** to improve both extraction and recall without replacing the existing memory system in phase 1.

The architectural decision is explicit:

1. OpenCode local memory stays authoritative for lifecycle state and injection decisions
2. Hindsight runs in **local embedded mode only**, per workspace or project, with no remote SaaS dependency
3. Hindsight participates in **both extract and recall**
4. Rollout is phased and always falls back to existing behavior when Hindsight is unavailable or disabled

## Goals

- Improve recall relevance using local Hindsight ranking instead of relying only on the current recall-agent filter
- Improve extraction quality by retaining session content into Hindsight and using Hindsight-derived observations or recall as structured candidate input
- Keep all data local-first and private by using embedded local deployment only
- Preserve the existing memory lifecycle, UI, and JSON-backed storage as the source of truth in phase 1
- Add clear config, observability, lifecycle management, and failure fallback paths
- Support phased rollout, optional backfill, and safe disablement without breaking current memory behavior

## User Stories

### US-001: Local Embedded Companion Lifecycle

**Description:** As a user, I want Hindsight to run locally inside my workspace context so memory enhancement stays private and does not require a cloud service.

**Acceptance Criteria:**

- [ ] Add a local embedded Hindsight mode using `@vectorize-io/hindsight-all` plus `@vectorize-io/hindsight-client`, or an equivalent local-only embedded daemon path approved in implementation
- [ ] Hindsight binds to local loopback only, such as `127.0.0.1`, and is never required to call a remote Hindsight SaaS
- [ ] Service lifecycle supports start, health check, reuse, and shutdown for the current workspace or project
- [ ] If the service fails to start, memory features continue using existing behavior without user data loss
- [ ] Logs clearly distinguish `disabled`, `starting`, `ready`, `degraded`, and `fallback` states
- [ ] Typecheck passes
- [ ] Build passes

### US-002: Configurable Local Integration Mode

**Description:** As a user, I want to enable, disable, and tune the local integration through standard config so I can control rollout and resource usage.

**Acceptance Criteria:**

- [ ] Add `config.memory.hindsight` schema in `packages/opencode/src/config/config.ts`
- [ ] Config supports at minimum: `enabled`, `mode`, `extract`, `recall`, `backfill`, `workspace_scope`, `bank_prefix`, `startup_timeout_ms`, `query_timeout_ms`, and `log_level`
- [ ] `mode` only allows local embedded values in phase 1 and does not expose remote SaaS configuration
- [ ] If `enabled: false`, the system behaves exactly like current memory behavior
- [ ] If `extract: false` or `recall: false`, the disabled path falls back independently without affecting the other path
- [ ] Invalid config fails fast during config parsing
- [ ] Typecheck passes

### US-003: Retain Session Content Into Local Banks

**Description:** As a developer, I want session content to be retained into Hindsight with stable ids and metadata so extraction and recall can query richer local context.

**Acceptance Criteria:**

- [ ] When memory auto-extract or manual extraction runs, persist session or conversation slices into Hindsight before or alongside extraction analysis
- [ ] Each retained Hindsight document uses a stable id derived from workspace, session, message range, or memory source identity so re-ingest is idempotent
- [ ] Each retained document includes metadata for at minimum: `workspace_id`, `project_root`, `session_id`, `memory_id` when applicable, `source_kind`, `created_at`, `categories`, `tags`, and `status`
- [ ] Bank mapping is explicit and documented for experience, observation, and world-like content classes used in phase 1
- [ ] Repeated retention updates existing local references instead of creating uncontrolled duplicates when ids match
- [ ] Retention failures are logged and do not block current extraction flow
- [ ] Typecheck passes

### US-004: Use Hindsight During Extraction

**Description:** As a user, I want Hindsight to help extraction so the system can create better structured memories from conversation history.

**Acceptance Criteria:**

- [ ] `packages/opencode/src/memory/engine/extractor.ts` receives optional Hindsight-derived context in addition to existing memories and recent messages
- [ ] Hindsight contributes candidate observations, facts, or recall snippets that help the extractor decide `create` or `update`
- [ ] Extractor output still creates or updates authoritative local memories through the existing `Memory.create()` and `Memory.update()` paths
- [ ] If Hindsight is unavailable, extraction still works with the current prompt and current logic
- [ ] Extraction logs report whether Hindsight input was used and how many candidate items were supplied
- [ ] Typecheck passes
- [ ] Relevant extraction tests pass

### US-005: Use Hindsight During Recall

**Description:** As a user, I want Hindsight to rank relevant local memory candidates so the system injects better memories into prompts.

**Acceptance Criteria:**

- [ ] `packages/opencode/src/memory/engine/recall.ts` queries Hindsight during recall when enabled
- [ ] Hindsight returns relevant local source references, document ids, or mapped memory ids instead of becoming the final injected memory payload itself
- [ ] OpenCode still decides the final injected memories from authoritative local records in `Memory.list()` or equivalent local lookup
- [ ] If Hindsight returns missing or stale ids, those references are ignored safely
- [ ] If Hindsight fails or times out, recall falls back to the current recall-agent path or current candidate behavior without user-facing breakage
- [ ] Recall logs report ranked hits, resolved local ids, dropped stale ids, and fallback reason when used
- [ ] Typecheck passes
- [ ] Relevant recall tests pass

### US-006: Preserve Authoritative Local Lifecycle

**Description:** As a developer, I want phase 1 to keep local JSON-backed memory authoritative so existing lifecycle features keep working without a risky migration.

**Acceptance Criteria:**

- [ ] Local memory remains the source of truth for `status`, `score`, `useCount`, `hitCount`, `meta`, `confirmation`, `decay`, and UI rendering
- [ ] Hindsight does not directly replace `packages/opencode/src/memory/storage.ts` in phase 1
- [ ] Hit tracking and injection still update local memory records even when Hindsight influenced ranking
- [ ] Confirmation and decay continue to operate on local memories only
- [ ] The design documents why full source-of-truth replacement is deferred
- [ ] Typecheck passes

### US-007: Add Backfill and Migration Safety

**Description:** As an existing user, I want my current local memories to be usable with Hindsight without losing data or requiring a hard cutover.

**Acceptance Criteria:**

- [ ] Add an optional backfill path that ingests existing local memories into Hindsight with stable source references
- [ ] Backfill is resumable or idempotent and can be safely retried
- [ ] Backfill progress is observable through logs or stored meta state
- [ ] Phase 1 does not require migration of local JSON memory files out of current storage
- [ ] Disabling Hindsight after backfill does not break local memory reads or injection
- [ ] Typecheck passes

### US-008: Add Observability and Failure Handling

**Description:** As a developer, I want logs and events around Hindsight behavior so rollout is debuggable and failures are safe.

**Acceptance Criteria:**

- [ ] Add structured logs for service lifecycle, retain requests, recall queries, extraction assist, fallback, timeout, and backfill
- [ ] Publish new memory events or equivalent observability hooks for major Hindsight transitions where appropriate
- [ ] Timeouts are configurable and treated as non-fatal
- [ ] Health-check failures degrade gracefully instead of crashing session execution
- [ ] Observability data avoids leaking more content than existing memory logs already allow
- [ ] Typecheck passes

### US-009: Roll Out in Phases With Fallback

**Description:** As a maintainer, I want phased rollout controls so we can validate the integration before expanding the blast radius.

**Acceptance Criteria:**

- [ ] Phase 1 supports local embedded Hindsight as an optional companion only
- [ ] Phase 1 preserves current behavior as the default fallback path
- [ ] Phase 2 planning may improve more source types, bank usage, and extraction prompts, but is not required for initial merge
- [ ] Feature flags or config switches allow enabling recall-only, extract-only, or both for testing
- [ ] Rollout notes document how to disable the feature cleanly
- [ ] Typecheck passes

### US-010: Verify End-to-End Behavior

**Description:** As a developer, I want deterministic tests around extract, recall, fallback, and mapping so future changes do not silently break the integration.

**Acceptance Criteria:**

- [ ] Add unit tests for id mapping, metadata mapping, and stale reference filtering
- [ ] Add tests for extract path with Hindsight enabled and disabled
- [ ] Add tests for recall path with Hindsight ranked references and fallback on timeout or startup failure
- [ ] Add tests for backfill idempotency
- [ ] Add integration coverage for local authoritative injection after Hindsight ranking
- [ ] Typecheck passes
- [ ] Build passes
- [ ] Relevant tests pass from the correct package directory

## Functional Requirements

- FR-1: Hindsight integration must operate in local embedded mode only during phase 1
- FR-2: OpenCode local memory remains authoritative for lifecycle state, storage, and final injection decisions
- FR-3: Hindsight must participate in both extraction and recall when the feature is enabled for those paths
- FR-4: Extract integration must support retaining session content with stable document ids and structured metadata
- FR-5: Recall integration must resolve Hindsight results back to local ids or source references before injection
- FR-6: Hindsight failures must never block normal session flow, memory extraction, or prompt injection
- FR-7: Config must support independent toggles for extract and recall participation
- FR-8: Bank mapping, document id mapping, and metadata mapping must be deterministic and documented
- FR-9: Existing lifecycle features such as confirmation, decay, hit tracking, and memory manager UI must continue to work without Hindsight-specific rewrites
- FR-10: Existing local memory files remain valid and readable whether Hindsight is enabled or disabled
- FR-11: Optional backfill must be idempotent and safe to resume
- FR-12: Logging and metrics must make fallback frequency and Hindsight usage observable during rollout

## Non-Goals

- No remote or cloud Hindsight SaaS integration in phase 1
- No replacement of `packages/opencode/src/memory/storage.ts` as the primary memory store in phase 1
- No migration of lifecycle fields such as `score`, `status`, `useCount`, or `hitCount` into Hindsight as the authoritative record
- No requirement to inject raw Hindsight documents directly into prompts without local memory resolution
- No forced backfill before users can keep using the current memory system
- No redesign of the memory manager UI before the backend integration proves stable

## Design Considerations

### Local-first privacy

The integration must preserve the repo's local-memory posture. All Hindsight execution in phase 1 runs on the local machine and stores data in a local embedded deployment.

### Authoritative lifecycle boundary

The current memory layer already owns scoring, confirmation, hit tracking, decay, meta, and UI behavior. Phase 1 should not move those responsibilities because that would multiply migration risk and blur operational ownership.

### Extract and recall are both required

Hindsight is not a recall-only add-on in this design. It must assist both by retaining richer source material for later retrieval and by producing structured candidate context during extraction.

### Workspace-companion model

Hindsight should behave like a companion service per workspace or project, not as a global shared cloud dependency. This keeps mapping and lifecycle simpler and matches the current project-isolated memory model.

### Stable ids before deeper automation

Stable source ids and metadata mapping are required before stronger retrieval can be trusted. Without deterministic mapping, fallback, deduplication, and stale-reference cleanup become fragile.

## Technical Considerations

### Existing seams to extend

Phase 1 should integrate through the current memory boundaries instead of replacing them:

- `packages/opencode/src/memory/engine/extractor.ts`
- `packages/opencode/src/memory/engine/recall.ts`
- `packages/opencode/src/memory/hooks/auto-extract.ts`
- `packages/opencode/src/memory/hooks/inject.ts`
- `packages/opencode/src/memory/hooks/hit-tracker.ts`
- `packages/opencode/src/memory/memory.ts`
- `packages/opencode/src/memory/storage.ts`
- `packages/opencode/src/memory/engine/confirmation.ts`
- `packages/opencode/src/memory/optimizer/decay.ts`
- `packages/opencode/src/config/config.ts`

### Phase plan

**P0: Service and mapping foundation**

- Add config schema, local service lifecycle, health checks, bank mapping, and id mapping
- Add no-op fallback wiring so current behavior remains intact when disabled

**P1: Recall integration**

- Retain enough local source documents to support useful ranking
- Query Hindsight during recall and resolve hits back to local ids before injection

**P2: Extract integration**

- Feed Hindsight-derived recall, observations, or structured facts into extractor context
- Retain new conversation slices during extraction and auto-extract flows

**P3: Backfill and observability hardening**

- Add optional backfill for existing memories
- Add rollout metrics, more logs, and stronger degraded-mode handling

### Bank and type mapping

Phase 1 should use a small, explicit mapping instead of trying to mirror every Hindsight concept at once.

- Stable local memories map to Hindsight documents with metadata carrying local memory ids
- Conversation slices map to experience-style records
- Extracted facts or observations map to observation-style records when supported
- Shared durable policies or project facts may map to world-style records later, but should stay limited in phase 1

### Fallback policy

If startup, health check, retention, or recall query fails, the system logs the reason and continues with the current local behavior. No session should fail only because Hindsight is degraded.

### Verification expectations

Implementation should ship with typecheck, build, and targeted memory tests. If a lightweight local Hindsight test harness is needed, it should run from the correct package directory and avoid requiring repo-root test execution.

## Success Metrics

- Recall selects more relevant local memories than the current baseline in targeted memory scenarios
- Extraction creates fewer missed or under-specified memories in sessions with recoverable context
- Fallback behavior keeps memory features usable even when Hindsight is disabled or unavailable
- Local-only deployment works without remote credentials or SaaS dependency
- Backfill and re-ingest remain idempotent in repeated runs

## Open Questions

1. Which embedded path should be the default in code: supervised `@vectorize-io/hindsight-all` or direct `hindsight-embed` CLI management?
2. Should Hindsight data be scoped per workspace root only, or per project plus user identity when one workspace is shared?
3. Which Hindsight bank layout best matches current OpenCode categories without overfitting phase 1?
4. How much raw conversation should be retained per slice so recall quality improves without excessive local storage growth?
5. Should backfill run automatically on first enable, or only through an explicit command or hook?
