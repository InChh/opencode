# PRD: Session Rotation for Swarm Conductor & Workers

## Introduction

当 Swarm 中的 Conductor 或 Worker 在长期迭代中积累大量上下文后，现有的 Compaction 机制通过 LLM 摘要进行有损压缩，导致关键细节不可逆丢失，且摘要质量递减（摘要的摘要的摘要…）。

Session Rotation 引入一种新策略：**第一次上下文溢出时正常 Compaction，第二次溢出时改为 Rotation**——生成结构化 Checkpoint → 归档旧 Session → 创建新 Session → 通过 Checkpoint + Board + Memory 快速恢复上下文。同时在任务完成边界也可主动触发 Rotation。这使得每个新 Session 都拥有 100% 的上下文窗口用于当前工作，避免了二次 Compaction（摘要的摘要）导致的信息严重衰减，同时保留完整的历史可追溯性。

## Goals

- 让 Conductor 和 Worker 可以在长期迭代中保持恒定的上下文质量，不受上下文窗口限制
- 通过结构化 Checkpoint（而非有损 LLM 摘要）保留关键决策、进度和发现
- 在第二次 Compaction 触发时或任务完成边界时自动 Rotation，对 LLM 透明
- 旧 Session 归档保留，支持通过 checkpoint chain 追溯完整历史
- Checkpoint 核心结构模板化生成（零 LLM 成本），关键决策和发现部分使用 LLM 提取（混合模式）
- 与现有 Compaction 机制共存：overflow 时优先 Rotation，失败时 Compaction 兜底

## User Stories

### US-001: Checkpoint 数据结构

**Description:** As a developer, I need a structured Checkpoint schema so that rotation can produce and consume consistent handoff documents.

**Acceptance Criteria:**

- [ ] 在 `src/board/checkpoint.ts` 中定义 `Checkpoint` 命名空间
- [ ] Checkpoint schema 包含以下字段：`goal`（string）、`task`（当前 task ID + subject）、`progress`（完成项和待做项的列表）、`decisions`（关键决策列表）、`state`（当前工作状态描述）、`files`（涉及的关键文件列表）、`session_chain`（前序 session IDs 数组）
- [ ] 提供 `Checkpoint.generate(sessionID, options)` 函数，接受 session ID 并返回 Checkpoint 内容字符串
- [ ] 生成函数使用混合模式：从 Board task/artifact 状态模板化填充 `goal`、`task`、`progress`、`files`；用 LLM（轻量模型）提取 `decisions` 和 `state`
- [ ] 模板化部分不调用 LLM，直接从 `BoardTask.list()`、`BoardArtifact.list()`、session 消息历史中提取
- [ ] LLM 提取部分复用 Compaction 的消息准备逻辑：调用 `MessageV2.toModelMessages(messages, model, { stripMedia: true, stripSynthetic: true })` 获得完整输入，使用 `compaction` agent（已有的轻量 agent），仅替换 prompt（从"总结对话"变为"提取关键决策和当前工作状态"）
- [ ] 生成的 Checkpoint 写入 Board artifact（type: `"checkpoint"`），已有的 `BoardArtifact.Type` enum 已包含 `"checkpoint"`
- [ ] Typecheck passes

### US-002: Session 归档机制

**Description:** As a developer, I need to archive old sessions so that rotation can cleanly end the old session while preserving it for traceability.

**Acceptance Criteria:**

- [ ] 在 `Session` 命名空间中添加 `archive(sessionID)` 函数
- [ ] `archive()` 设置 `session.time.archived = Date.now()`，Session schema 中 `time.archived` 已存在（为 optional number）
- [ ] 已归档的 Session 不再接受新的 `SessionPrompt.prompt()` 调用（prompt 函数检查 archived 状态并跳过）
- [ ] 已归档的 Session 仍可通过 `Session.get()` 读取（不删除任何数据）
- [ ] 发布 `session.archived` Bus event
- [ ] Typecheck passes

### US-003: Session Rotation 核心流程

**Description:** As a Swarm Worker/Conductor, I want to automatically rotate to a fresh session when context grows too large or a task completes, so that I maintain high-quality context throughout long iterations.

**Acceptance Criteria:**

- [ ] 在 `src/session/rotation.ts` 中实现 `SessionRotation` 命名空间
- [ ] 提供 `rotate(input: { sessionID, swarmID, trigger })` 函数，trigger 为 `"overflow" | "boundary" | "manual"`
- [ ] Rotation 流程按以下顺序执行：(1) Memory extraction (2) Checkpoint generation (3) Archive old session (4) Create new session with same permissions (5) Inject bootstrap prompt (6) Update Swarm worker reference
- [ ] 新 Session 的 `SessionMetadata` 记录 `prev_session`（旧 session ID）和 `rotation_seq`（轮换序号，从 0 开始递增）
- [ ] 新 Session 创建时使用与旧 Session 相同的权限配置（从旧 Session 的 `permission` 字段复制）
- [ ] 如果旧 Session 是 Swarm Worker，调用 `Swarm.replaceWorkerSession()` 更新 `Swarm.Info.workers` 数组中的 `session_id` 引用
- [ ] 如果旧 Session 是 Conductor，更新 `Swarm.Info.conductor` 为新 session ID
- [ ] 返回新 Session 的 Info
- [ ] Typecheck passes

### US-004: Bootstrap Prompt 生成

**Description:** As a newly rotated session, I need a concise bootstrap prompt containing checkpoint, board state, and relevant memories so that I can continue working without re-reading the entire history.

**Acceptance Criteria:**

- [ ] 在 `SessionRotation` 中提供 `bootstrap(input: { checkpoint, swarmID, taskID?, memories? })` 函数
- [ ] Bootstrap prompt 包含三个区块：`<checkpoint>...</checkpoint>`（Checkpoint 内容）、`<board_state>...</board_state>`（Board 快照摘要：task 统计、当前 task 详情、最近 5 条信号）、`<memories>...</memories>`（相关 memory 条目，使用 checkpoint 中的关键词召回）
- [ ] Bootstrap prompt 总大小控制在 6000 tokens 以内（通过限制每个区块的最大字符数实现）
- [ ] 生成的 prompt 通过 `SessionPrompt.prompt()` 注入新 session，使用对应的 agent（conductor 或 worker 的 agent）
- [ ] Typecheck passes

### US-005: Compaction 后触发 Rotation

**Description:** As a session processor, I need to trigger rotation on the second compaction attempt instead of compacting again, so that sessions get a fresh context window with high-fidelity recovery rather than degraded double-summarization.

**Acceptance Criteria:**

- [ ] 在 `SessionRotation` 中提供 `shouldRotate(input: { sessionID })` 函数，内聚所有判断逻辑，调用方只看 true/false
- [ ] **Worker 判断逻辑**：session 属于 Swarm（通过 `SessionMetadata.get(sessionID)` 检查 `swarm_id`）**且** session 已经被 Compaction 过至少一次（通过检查 session 消息历史中是否存在 `summary === true` 的 assistant message 判断）→ 返回 true
- [ ] **Conductor 判断逻辑**（内聚在 `shouldRotate` 中）：同样要求已 Compaction 过至少一次；额外检查：如果 `conductor_defer` 配置为 true 且有 Worker 仍在运行（Board snapshot stats `running > 0`）且 Compaction 次数 < 2 → 返回 false（延迟，让调用方走 Compaction 兜底）；Compaction 次数 ≥ 2 时无论 Worker 状态都返回 true（硬上限）
- [ ] 非 Swarm session 始终返回 false（不影响普通 session 的行为）
- [ ] 尚未经历过 Compaction 的 Swarm session 也返回 false（第一次仍走正常 Compaction）
- [ ] 在 `prompt.ts` 的 session loop 中，当 `isOverflow` 为 true 时先调用 `shouldRotate`：为 true 则执行 Rotation 并 break 当前 loop（新 session 会被 Swarm monitor 驱动）；为 false 则走正常 Compaction
- [ ] 如果 rotation 失败（例如 Board 不可用），回退到 Compaction，保证系统不中断
- [ ] 第一次 Compaction 生成的摘要会被 Checkpoint 生成流程利用：`Checkpoint.generate()` 可以读取该摘要作为历史上下文的一部分（比重新从全量消息提取更高效）
- [ ] Typecheck passes

### US-006: 任务边界触发

**Description:** As a Swarm Worker, I want to automatically rotate when my assigned task completes, so that the next task starts with a clean context.

**Acceptance Criteria:**

- [ ] 在 `board_write` 工具处理 task status 更新时，当 Worker 将 task 设为 `"completed"` 或 `"failed"` 时，检查是否应触发 rotation
- [ ] 触发条件：session 属于 Swarm（有 `swarm_id` metadata）且 session 有对应的 `task_id` metadata 且 task 状态变为终态（completed/failed/cancelled）
- [ ] 当条件满足时，设置 `needsRotation = true` flag（类似现有的 `needsCompaction` 机制），使 processor 在下一个 `finish-step` 时返回 `"rotate"` 结果
- [ ] `prompt.ts` 的 session loop 收到 `"rotate"` 结果后，执行 `SessionRotation.rotate({ trigger: "boundary" })` 并 break 当前 loop
- [ ] 这保证旧 session 在 rotation 前完成当前 step（signal 发送、artifact 写入等都已完成）
- [ ] 如果 Worker 的下一个 task 由 Conductor 重新分配（通过新的 `delegate_task` 调用），Conductor 应该使用新 session ID
- [ ] Typecheck passes

### US-007: Swarm Worker Session 替换

**Description:** As a Swarm system, I need to replace a worker's session reference when rotation occurs, so that the Conductor and monitor continue to track the correct active session.

**Acceptance Criteria:**

- [ ] 在 `Swarm` 命名空间中添加 `replaceWorkerSession(swarmID, oldSessionID, newSessionID)` 函数
- [ ] 函数在 `Swarm.Info.workers` 数组中找到 `session_id === oldSessionID` 的条目，替换为 `newSessionID`
- [ ] 如果 `oldSessionID` 是 Conductor session（`Swarm.Info.conductor === oldSessionID`），更新 `Swarm.Info.conductor` 为 `newSessionID`
- [ ] 更新 `Swarm.Info.time.updated`
- [ ] 发布 `Swarm.Event.Updated` 事件
- [ ] Monitor 的 signal watch 自动适用于新 session（signal 按 swarm_id 路由，不按 session_id）
- [ ] `SessionMetadata` 为新 session 复制旧 session 的 `swarm_id`、`task_id`、`discussion_channel` 元数据
- [ ] Typecheck passes

### US-008: Conductor Checkpoint 扩展内容

**Description:** As a Conductor, I need my checkpoint to include coordination-specific context (worker assignments, escalations, overall progress), so that a rotated Conductor session can resume orchestration seamlessly.

**Acceptance Criteria:**

- [ ] Conductor 的 rotation 判断已内聚在 `shouldRotate` 中（见 US-005），本 story 不涉及触发逻辑
- [ ] `Checkpoint.generate()` 检测到 session 是 Conductor（`Swarm.Info.conductor === sessionID`）时，额外填充以下字段：Worker 分配策略（当前 Worker 列表及其 task 分配）、待处理的 escalation 信息（从 Board signals 中筛选 type=blocked/conflict 的未解决信号）、整体进度评估（Board stats 中的 completed/total 比例）
- [ ] 这些额外字段以独立区块 `<coordination>...</coordination>` 加入 Checkpoint 内容
- [ ] Bootstrap prompt 中 Conductor 的 `<checkpoint>` 区块自然包含这些协调信息
- [ ] Typecheck passes

### US-009: 配置集成

**Description:** As a user, I need configuration options for session rotation behavior, so that I can tune thresholds and enable/disable the feature.

**Acceptance Criteria:**

- [ ] 在 config schema 中添加 `rotation` 配置组，包含：`enabled`（boolean，默认 true）、`checkpoint_llm`（boolean，默认 true，是否用 LLM 提取 decisions/state 部分）、`max_bootstrap_tokens`（number，默认 6000，bootstrap prompt 的最大 token 数）、`conductor_defer`（boolean，默认 true，Conductor 是否在有 running worker 时延迟 rotation）
- [ ] 当 `rotation.enabled === false` 时，`shouldRotate` 始终返回 false，完全回退到 Compaction 行为
- [ ] 配置支持 project-level 和 global-level override
- [ ] Typecheck passes

### US-010: Rotation 事件与可观测性

**Description:** As a system operator, I need rotation events and logging so that I can monitor rotation behavior and debug issues.

**Acceptance Criteria:**

- [ ] 定义 Bus events：`session.rotation.started`（包含 sessionID、swarmID、trigger、rotation_seq）和 `session.rotation.completed`（包含 oldSessionID、newSessionID、checkpoint artifact ID、bootstrap_tokens）
- [ ] Rotation 过程中的每个步骤记录 structured log（使用 `Log.create({ service: "session.rotation" })`）
- [ ] 记录 rotation metrics：checkpoint 生成耗时、LLM 提取耗时（如果启用）、bootstrap prompt 大小、rotation 总耗时
- [ ] 如果 rotation 失败，记录 error 并回退到 Compaction，不中断 session 运行
- [ ] Typecheck passes

## Functional Requirements

- FR-1: Checkpoint 使用混合生成模式——结构化字段（goal、task、progress、files）从 Board 状态模板化提取；隐含知识字段（decisions、state）使用 LLM（compaction agent）从最近消息提取
- FR-2: 模板化部分调用 `BoardTask.list()`、`BoardArtifact.list()`；LLM 部分复用 Compaction 的消息准备逻辑（`toModelMessages` + stripMedia + stripSynthetic），仅替换 prompt
- FR-3: Rotation 流程严格顺序执行：Memory extraction → Checkpoint → Archive → Create → Bootstrap → Replace reference
- FR-4: 旧 Session 归档后仍可通过 `Session.get()` 读取，但不再接受新消息
- FR-5: 新 Session 通过 Bootstrap prompt（<6K tokens）获得恢复上下文，包含 checkpoint、board snapshot、memory recall 三部分
- FR-6: Swarm Worker 在 task 完成/失败时自动触发 boundary rotation；当第二次 Compaction 触发时改为 Rotation
- FR-7: Conductor 同样在第二次 Compaction 时触发 Rotation；如果有 running worker 可延迟一次（最多容忍 2 次 Compaction 后强制 Rotation）
- FR-8: 非 Swarm session 不受影响（shouldRotate 始终返回 false）
- FR-9: Rotation 失败时回退到 Compaction，保证系统不中断
- FR-10: `Swarm.replaceWorkerSession()` 原子更新 worker 引用，确保 monitor 不丢失信号

## Non-Goals

- 不改变现有 Compaction 机制的行为（Rotation 是新增路径，不是替换）
- 不支持非 Swarm session 的 rotation（普通 session 继续使用 Compaction）
- 不实现跨 Swarm 的 checkpoint 共享（checkpoint 绑定单个 swarm）
- 不实现 UI 层面的 rotation 可视化（仅后端和 Bus 事件）
- 不自动合并旧 session 的 memory 到新 session（依赖已有的 memory recall 机制）
- 不修改 Discussion mode 的 round 机制（Discussion 已有 max_rounds 限制）

## Technical Considerations

### 现有基础设施复用

- **Board Artifact**: `type: "checkpoint"` 已在 `BoardArtifact.Type` enum 中定义，直接使用
- **Session archive**: `Session.Info.time.archived` 字段已存在于 schema 中，只需实现 `archive()` 函数
- **Memory extraction**: `MemoryExtractor.extractFromSession()` 已有完整实现，直接调用
- **Board snapshot**: `SharedBoard.snapshot()` 已有缓存机制，直接使用
- **SessionMetadata**: 已支持 `set/get`，用于 `prev_session`、`rotation_seq` 等

### 新增文件

- `src/board/checkpoint.ts` — Checkpoint 生成逻辑
- `src/session/rotation.ts` — Rotation 核心流程和触发逻辑

### 修改文件

- `src/session/processor.ts` — 在 finish-step 中处理 `needsRotation` flag，新增返回值 `"rotate"`
- `src/session/prompt.ts` — 在 session loop 中处理 `"rotate"` 返回值和 overflow 分支的 shouldRotate 检查
- `src/session/swarm.ts` — 添加 `replaceWorkerSession()` 和 Conductor rotation 策略
- `src/session/index.ts` — 添加 `archive()` 函数
- `src/config/config.ts` — 添加 `rotation` 配置组

### 关键设计约束

- Rotation 过程中旧 session 必须先完成当前 step（不能中途打断工具执行）
- Bootstrap prompt 必须控制在 6K tokens 以内（保证新 session 有充足空间）
- Checkpoint 的 LLM 提取部分失败时，仍生成不含 decisions/state 的模板化 checkpoint（优雅降级）
- Monitor 的 signal watch 基于 swarm_id 路由，session 替换不影响信号转发

### 与 Compaction 的关系

```
正常流程：Prune → isOverflow? → (否) 继续执行
                              → (是) 已 Compaction 过 && 是 Swarm session?
                                     → (是) Rotation → 新 Session
                                     → (否) Compaction → 同 Session 继续
                                                        （下次 overflow 时走 Rotation）
```

核心思路：**第一次 overflow 正常 Compaction，第二次 overflow 时改为 Rotation**。这样：

1. 不引入新的阈值配置（复用现有 Compaction 触发逻辑）
2. 第一次 Compaction 的摘要自然成为 Checkpoint 的输入（比从全量消息提取更高效）
3. 避免了摘要的摘要（二次 Compaction）导致的信息严重衰减
4. Rotation 失败时回退到 Compaction 兜底，保证系统不中断

## Success Metrics

- Swarm Worker 在 10+ 轮迭代中维持恒定的上下文质量（不出现信息丢失导致的重复工作）
- Rotation 后新 Session 的 bootstrap prompt < 6K tokens
- Checkpoint 生成延迟 < 5 秒（模板化部分 < 100ms，LLM 部分 < 5s）
- Rotation 总延迟 < 10 秒（包括 memory extraction + checkpoint + session creation）
- 零 LLM 调用中断：rotation 失败时 Compaction 兜底成功率 100%

## Open Questions

1. **Checkpoint 中的 files 列表**：应该从 session 消息中提取（分析 read/edit/write 工具调用的文件参数），还是从 Board artifact 的 `files` 字段聚合？前者更完整但需要遍历消息。
2. **Memory recall 的 tag 匹配**：bootstrap 阶段 recall memory 用什么关键词？可以从 checkpoint 的 goal + task subject 中提取，但可能召回不精确。
3. **Conductor 的 "batch boundary" 判定**：当 Workers 是 background 执行时，如何准确知道"当前批次已完成"？Board stats 的 `running === 0` 可能不够精确（Worker 可能在 idle 但 Conductor 还没发下一批任务）。
4. **跨 rotation 的工具状态**：如果旧 session 中有一个 `edit` 工具调用修改了文件但还没保存，rotation 后新 session 是否需要知道这个中间状态？当前设计假设 rotation 只在 step 完成后触发，不存在中间状态。
