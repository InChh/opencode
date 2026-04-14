# Tech: Hindsight Local Memory Integration

## Overview

本文定义 phase 1 的落地方案。目标是把 Hindsight 接入现有 memory system，但不替换本地 JSON authority。

核心原则只有三条：

- `packages/opencode/src/memory/storage.ts` 继续是 authoritative store
- Hindsight 只走 local embedded mode
- Hindsight 同时参与 `extract` 和 `recall`

## Why local stays authoritative

现有系统已经在本地 memory 上承载 `status`、`score`、`useCount`、`hitCount`、`meta`、`confirmation`、`decay` 和 UI。直接把 authority 切到 Hindsight，会把 retrieval 升级变成 lifecycle 重构。

phase 1 的目标是先增强 retrieval 和 extraction quality。这样 blast radius 小，也能保留现有 fallback。

## Architecture

建议增加一个小型 companion 子系统，集中管理 daemon、id mapping、retain 和 query。

推荐目录：

- `packages/opencode/src/memory/hindsight/client.ts`
- `packages/opencode/src/memory/hindsight/service.ts`
- `packages/opencode/src/memory/hindsight/mapper.ts`
- `packages/opencode/src/memory/hindsight/bank.ts`
- `packages/opencode/src/memory/hindsight/retain.ts`
- `packages/opencode/src/memory/hindsight/recall.ts`
- `packages/opencode/src/memory/hindsight/backfill.ts`
- `packages/opencode/src/memory/hindsight/event.ts` if needed

现有文件主要做集成点修改：

- `packages/opencode/src/memory/engine/extractor.ts`
- `packages/opencode/src/memory/engine/recall.ts`
- `packages/opencode/src/memory/hooks/auto-extract.ts`
- `packages/opencode/src/memory/hooks/inject.ts`
- `packages/opencode/src/memory/hooks/hit-tracker.ts`
- `packages/opencode/src/memory/memory.ts`
- `packages/opencode/src/config/config.ts`

## Draw the boundary

OpenCode local memory 负责 lifecycle。Hindsight 负责 local semantic retrieval and structured retention.

边界如下：

- Local memory owns: create, update, confirm, decay, inject decision, hit tracking, UI read model
- Hindsight owns: local daemon, embedding/indexing, ranked retrieval, retained conversation docs, optional observations
- Mapping layer owns: `memory_id <-> hindsight document/source reference`

## Map the data

phase 1 不需要把所有本地字段复制成 Hindsight first-class schema。只需要稳定映射和最小 metadata。

建议 document metadata：

```ts
{
  workspace_id: string
  project_root: string
  session_id?: string
  memory_id?: string
  source_kind: "memory" | "session_slice" | "observation"
  categories?: string[]
  tags?: string[]
  status?: string
  created_at: number
  updated_at?: number
}
```

建议 bank mapping：

- `experience` bank: session conversation slices, interaction transcripts
- `observation` bank: Hindsight reflect or extraction-ready facts
- `world` bank: durable project facts or rules, only for narrow phase 1 cases

本地 memory category 不直接变成 bank。category 放在 metadata，bank 只表达 retrieval shape。

## Define stable ids

必须先解决 idempotency。否则 backfill、re-retain 和 stale cleanup 都会失控。

建议规则：

- Local memory doc id: `mem:${workspaceHash}:${memory.id}`
- Session slice doc id: `sess:${workspaceHash}:${sessionID}:${start}:${end}`
- Observation doc id: `obs:${workspaceHash}:${sessionID}:${hash}`

`workspaceHash` 用稳定 project/worktree identity 生成。不要依赖随机 uuid。

## Run the service

优先使用 `@vectorize-io/hindsight-all` + `@vectorize-io/hindsight-client`。它更适合 Node/Bun 内嵌监督模式。

保留 `hindsight-embed` CLI 作为实现备选，但 phase 1 最好只有一个默认路径。这样测试和 fallback 更简单。

生命周期建议：

1. First use 时 lazy start
2. Health check 成功后写入 in-process ready state
3. 同 workspace 复用同一 client/service handle
4. 进程退出时尝试优雅 shutdown
5. start/query timeout 都走非 fatal fallback

ASCII flow:

```text
OpenCode session
    |
    +--> MemoryHindsight.service()
             |
             +--> start local daemon on 127.0.0.1
             +--> health check
             +--> return client
             +--> on failure => degraded + fallback
```

## Integrate extract

`extract` 不是只在最后把结果写进 Hindsight。它应该在分析前后都使用 Hindsight。

推荐流程：

```text
session messages
   |
   +--> retain session slice into Hindsight experience bank
   |
   +--> query Hindsight for related docs / observations
   |
   +--> merge with existing local memories
   |
   +--> call existing MemoryExtractor LLM prompt
   |
   +--> create/update authoritative local memories
   |
   +--> retain resulting memory docs back into Hindsight
```

具体集成点：

- `packages/opencode/src/memory/engine/extractor.ts` 在 `Memory.list()` 后追加 Hindsight context gathering
- prompt 输入新增一个 section，比如 `## Hindsight context`
- section 内容只放有限条目，避免 prompt 膨胀
- local memory write path 仍然调用 `Memory.create()` / `Memory.update()`

extract path 的 Hindsight 输入建议分两类：

- ranked related documents
- structured observations or facts derived from retained conversation

如果 Hindsight 返回空、超时或 parse 失败，直接省略该 section。不要让 extractor flow fail closed。

## Integrate recall

`recall` 的目标不是让 Hindsight 直接决定注入文本。它只负责更强的 ranking。

推荐流程：

```text
recent conversation
   |
   +--> query Hindsight with session context
   |
   +--> get ranked source refs / memory ids
   |
   +--> resolve refs against local Memory.list()
   |
   +--> optional current recall-agent filter on narrowed set
   |
   +--> inject authoritative local memories
```

两种 phase 1 方案都可行：

- 方案 A: Hindsight 先缩小 candidate set，再交给现有 recall agent 做 final filter
- 方案 B: Hindsight 直接给 ranked ids，OpenCode 按 top-k 注入并保留 conflict logic

建议先做方案 A。它更保守，也更符合 phased rollout。

`packages/opencode/src/memory/engine/recall.ts` 需要：

- 先从本地 memory 拿全量或基础 candidate
- 若 hindsight enabled，调用 `memory/hindsight/recall.ts`
- 把结果 resolve 成本地 `Memory.Info[]`
- 对 stale ids 做 drop + log
- 若 Hindsight unavailable，走当前逻辑

## Decide injection ownership

`packages/opencode/src/memory/hooks/inject.ts` 不需要理解 Hindsight document schema。它只消费本地 memory ids 或 `Memory.Info`。

这样 injection hook 保持稳定。ranking source 可替换，但 injection contract 不变。

## Preserve hit tracking and decay

`packages/opencode/src/memory/hooks/hit-tracker.ts` 和 `packages/opencode/src/memory/optimizer/decay.ts` 继续只操作本地 memory。不要在 phase 1 试图同步 Hindsight 内部 usage counter。

如果需要观测 Hindsight 命中，可以额外记录 log 或 event。不要改写现有 authority field。

## Sketch the config

建议在 `packages/opencode/src/config/config.ts` 增加：

```ts
memory: {
  hindsight: {
    enabled: boolean
    mode: "embedded"
    extract: boolean
    recall: boolean
    backfill: boolean
    workspace_scope: "project" | "worktree"
    bank_prefix: string
    startup_timeout_ms: number
    query_timeout_ms: number
    retain_limit: number
    recall_limit: number
    observation_limit: number
    log_level: "error" | "warn" | "info" | "debug"
  }
}
```

默认建议：

- `enabled: false`
- `mode: "embedded"`
- `extract: true`
- `recall: true`
- `backfill: false`
- `workspace_scope: "project"`

phase 1 不开放 remote endpoint、api key、cloud tenant 等配置。

## Handle failure and fallback

失败处理必须细分。不要把所有异常都变成一个黑盒 `catch`。

建议分类：

- startup failure -> mark degraded, skip Hindsight for session/process window
- health failure -> recheck once, then fallback
- retain failure -> log and continue extract/recall
- query timeout -> fallback to current recall/extract context
- stale reference -> drop silently with debug log
- backfill interruption -> resume from checkpoint or re-run idempotently

fallback contract：

- user session must continue
- local memory create/update must continue
- injection must continue
- no destructive writeback to local memory on Hindsight partial failure

## Plan backfill

backfill 只把现有本地 memory 复制进入 Hindsight。它不是 schema migration。

建议实现：

1. Read all local memories
2. Map each memory to stable doc id + metadata
3. Upsert into Hindsight
4. Record checkpoint in local meta, such as `Memory.setMeta("hindsightBackfill")`

可以增加一个显式入口，但 phase 1 不强制需要独立 CLI。也可以在 enable 后由 hook 延迟触发一次。

## Add observability

至少需要这些日志字段：

- service state
- startup duration
- query duration
- retain count
- ranked hit count
- resolved local id count
- stale drop count
- fallback reason
- backfill progress

如果要加 event，建议保持轻量：

- `MemoryEvent.HindsightReady`
- `MemoryEvent.HindsightFallback`
- `MemoryEvent.HindsightBackfillProgress`

event 不是必须。日志优先。

## Change the files

建议新增和修改如下。

新增：

- `packages/opencode/src/memory/hindsight/service.ts` 管 daemon lifecycle
- `packages/opencode/src/memory/hindsight/client.ts` 管 SDK call wrapper
- `packages/opencode/src/memory/hindsight/mapper.ts` 管 id/metadata mapping
- `packages/opencode/src/memory/hindsight/bank.ts` 管 bank naming
- `packages/opencode/src/memory/hindsight/retain.ts` 管 retain/upsert
- `packages/opencode/src/memory/hindsight/recall.ts` 管 retrieval wrapper
- `packages/opencode/src/memory/hindsight/backfill.ts` 管 backfill and checkpoint

修改：

- `packages/opencode/src/memory/engine/extractor.ts`
- `packages/opencode/src/memory/engine/recall.ts`
- `packages/opencode/src/memory/hooks/auto-extract.ts`
- `packages/opencode/src/memory/hooks/inject.ts`
- `packages/opencode/src/memory/hooks/hit-tracker.ts`
- `packages/opencode/src/memory/memory.ts`
- `packages/opencode/src/config/config.ts`

如果需要暴露 state，可再补：

- `packages/opencode/src/memory/event.ts`

## Roll out in phases

### Phase 0

先接 service、config、mapping 和 no-op fallback。此时默认关闭。

### Phase 1

先上线 recall integration。因为收益明确，写路径风险更低。

### Phase 2

接 extract integration，包括 retain session slices 和 observation-assisted extraction。

### Phase 3

补 backfill、observability hardening 和 tuning。必要时再评估 world bank 扩展。

## Test the design

测试策略分三层。

### Unit

- `mapper` 的 stable id 生成
- metadata mapping
- stale ref filtering
- config parsing
- fallback decision logic

### Integration

- Hindsight enabled recall returns ranked refs -> resolves to local memory ids
- Hindsight timeout -> current recall path still works
- Hindsight extract context injected -> local memory create/update still works
- backfill re-run remains idempotent

### Behavior

- injection only sees authoritative local memories
- hit tracking still increments local records
- decay and confirmation remain unchanged when Hindsight is enabled

如果 CI 不适合拉起真实 daemon，可加 lightweight fake adapter for wrapper-level tests。真实 daemon smoke test 可以放成 opt-in integration test。

## Watch the risks

主要风险：

- local daemon lifecycle 在 Bun/Node 环境下不稳定
- retrieval 结果和 local memory 映射漂移
- extract prompt 因额外 context 过长而退化
- backfill 写入量过大导致首次启用卡顿

对应缓解：

- lazy start + timeout + process cache
- stable id + stale drop + upsert only
- hard limit Hindsight context size
- backfill 分批并记录 checkpoint

## Decide later

phase 1 之后再决定两件事：

- 是否让 Hindsight observation 成为本地 memory candidate 的更强输入
- 是否让部分 durable world facts 走更专门的 bank 策略

现阶段不要做 source-of-truth replacement。先把 companion 模式跑稳。
