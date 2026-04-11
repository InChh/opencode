# Swarm state machine v2 PRD

## Introduction

Define the final v2 swarm state machine around one canonical snapshot per swarm. This removes conflicting sources of truth across persistence, SSE, runtime coordination, and UI consumers.

The design keeps all final decisions from the current state machine proposal unchanged. It reorganizes them into implementation-sized stories and explicit requirements.

## Goals

- Establish one canonical `state.json` snapshot as the only authoritative state for each swarm
- Separate lifecycle `status` from execution `stage` across swarm state handling
- Restrict authoritative state transitions to the coordinator only
- Make snapshot persistence atomic, serial, and auditable
- Standardize SSE, Admin UI, Web UI, and TUI reads around the same v2 state model
- Keep verify skipping explicit and evidence-based only
- Make waiting workers block by default after `600s`, with config override via `lark-opencode.json`
- Require explicit unblock evidence before any blocked entity resumes
- Roll out v2 through cleanup/reset, not migration or compatibility paths
- Keep auto-archive optional and default-off, and keep purge manual only

## User Stories

### US-001: Define canonical snapshot schema

**Description:** As a platform engineer, I want one v2 snapshot schema for each swarm so that all authoritative state lives in one place.

**Acceptance Criteria:**

- [ ] The v2 schema defines one canonical file per swarm, such as `state.json`
- [ ] The schema includes `schema_version`, `rev`, `seq`, `swarm`, `workers`, `tasks`, `discussions`, `verify`, and `audit`
- [ ] `schema_version=2` is required for all newly created v2 swarms
- [ ] The PRD clearly marks authoritative fields versus metadata fields
- [ ] A minimal valid snapshot example is documented
- [ ] Typecheck passes

### US-002: Split lifecycle from execution phase

**Description:** As a coordinator implementer, I want `status` and `stage` to be separate so that terminal state and current execution work are never conflated.

**Acceptance Criteria:**

- [ ] `Swarm.status` is defined as `active | paused | blocked | completed | failed | stopped`
- [ ] `Swarm.stage` is defined as `planning | dispatching | executing | discussing | verifying | repairing | idle`
- [ ] `stage` never represents terminal lifecycle values
- [ ] `status` never represents active execution phases
- [ ] `completed | failed | stopped` always require `stage=idle`
- [ ] `paused -> active` resumes the exact stored `resume.stage`
- [ ] Typecheck passes

### US-003: Enforce coordinator-only writes

**Description:** As a system owner, I want only the coordinator to commit authoritative state so that writes remain consistent and auditable.

**Acceptance Criteria:**

- [ ] Only the coordinator can commit authoritative transitions to `state.json`
- [ ] Workers can only submit observations such as `started`, `progress`, `waiting`, `blocked`, `completed`, and `failed`
- [ ] Verify runners can only submit verify observations
- [ ] Discussion participants can only submit signals, votes, or artifacts
- [ ] Human admins can only issue commands such as `pause`, `resume`, `stop`, `retry_task`, `archive`, `unarchive`, and `purge`
- [ ] Direct non-coordinator mutation of the snapshot is treated as illegal and recorded in audit output
- [ ] Typecheck passes

### US-004: Validate swarm lifecycle and stage transitions

**Description:** As a coordinator implementer, I want strict swarm transition guards so that lifecycle behavior stays predictable.

**Acceptance Criteria:**

- [ ] Allowed `Swarm.status` transitions match the approved matrix
- [ ] Allowed `Swarm.stage` transitions match the approved matrix
- [ ] `completed`, `failed`, and `stopped` cannot return to `active`
- [ ] `paused` cannot transition directly to `completed`
- [ ] `blocked` cannot transition directly to `completed`
- [ ] `blocked` never auto-recovers based on elapsed time alone
- [ ] Typecheck passes

### US-005: Implement worker timeout and unblock rules

**Description:** As a runtime engineer, I want workers to move from waiting to blocked consistently so that stalled execution is visible and controlled.

**Acceptance Criteria:**

- [ ] `Worker.status` is defined as `queued | starting | running | waiting | blocked | completed | failed | cancelled | stopped`
- [ ] `waiting -> blocked` defaults to `600s`
- [ ] The timeout can be overridden with `lark-opencode.json` key `swarm.wait_timeout_seconds`
- [ ] If the config key is absent, the system falls back to `600`
- [ ] `blocked -> running` requires explicit unblock evidence and coordinator approval
- [ ] Elapsed time alone never unblocks a worker
- [ ] At most one non-terminal worker can exist for the same `task_id`
- [ ] Typecheck passes

### US-006: Keep task state aligned with execution

**Description:** As a task orchestration engineer, I want task state transitions to reflect worker and verify outcomes so that dependencies stay correct.

**Acceptance Criteria:**

- [ ] `BoardTask.status` is defined as `pending | ready | in_progress | verifying | completed | blocked | failed | cancelled`
- [ ] Task transitions follow the approved task matrix
- [ ] A task becomes `ready` only when all dependencies are `completed`
- [ ] Upstream `failed`, `cancelled`, or `blocked` dependencies keep downstream tasks in `pending`
- [ ] Downstream tasks do not auto-enter `blocked` unless the coordinator explicitly writes that state and reason
- [ ] Worker-to-task linkage follows the documented mapping for `in_progress`, `verifying`, `completed`, `blocked`, and `failed`
- [ ] Typecheck passes

### US-007: Model discussion rounds explicitly

**Description:** As a discussion workflow engineer, I want discussion state and round handling to be explicit so that multi-round decisions remain deterministic.

**Acceptance Criteria:**

- [ ] `Discussion.status` is defined as `idle | collecting | round_complete | consensus_ready | decided | exhausted | failed | cancelled`
- [ ] Discussion transitions follow the approved matrix
- [ ] `current_round` starts at `1`
- [ ] Only the coordinator can trigger `advance_round`
- [ ] No new `collecting` round starts when `current_round == max_rounds`
- [ ] `decided` and `exhausted` are mutually exclusive terminal states
- [ ] Typecheck passes

### US-008: Make verify state explicit and waiver-only when skipped

**Description:** As a verification engineer, I want verify state to be explicit so that completion rules remain auditable and safe.

**Acceptance Criteria:**

- [ ] `Verify.status` is defined as `idle | pending | running | passed | failed | repair_required | skipped | cancelled`
- [ ] Verify transitions follow the approved matrix
- [ ] `Verify.skipped` is allowed only when explicit waiver evidence exists
- [ ] `Verify.skipped` cannot come from legacy data, backfill, inferred logic, or default behavior
- [ ] `verify=pending | running` requires `swarm.status=active` and `swarm.stage=verifying`
- [ ] A swarm can complete only when all required tasks are `completed` and verify is `passed`, or `skipped` with explicit waiver evidence
- [ ] Typecheck passes

### US-009: Commit snapshot updates atomically

**Description:** As a storage engineer, I want each authoritative transition to commit atomically so that snapshot integrity survives process and delivery failures.

**Acceptance Criteria:**

- [ ] Only one coordinator writer can commit a given swarm at a time
- [ ] A single transaction can update `swarm`, `workers`, `tasks`, `discussions`, `verify`, and `audit`
- [ ] The commit flow uses read current snapshot, build next snapshot, validate, write temp file, `fsync`, and `rename`
- [ ] Each successful commit records `reason`, `actor`, `at`, and `txn`
- [ ] Each successful commit produces a new `rev`
- [ ] `seq` is strictly monotonic within a swarm
- [ ] A failure before `rename` leaves the previous snapshot authoritative
- [ ] A failure after `rename` but before SSE delivery still treats disk state as committed
- [ ] Typecheck passes

### US-010: Publish authoritative snapshot and transition events

**Description:** As a client integrator, I want a minimal authoritative SSE contract so that every consumer can rebuild current swarm state reliably.

**Acceptance Criteria:**

- [ ] Each swarm SSE stream exposes authoritative `snapshot` and `transition` events only
- [ ] Clients receive one full `snapshot` on connect
- [ ] Each successful transaction emits one or more `transition` events with `seq`
- [ ] Clients apply events in `seq` order
- [ ] Clients de-duplicate repeated `seq` values
- [ ] Clients request a fresh `snapshot` when a `seq` gap is detected
- [ ] Transition logs feed the overall logging system but are not treated as the business source of truth
- [ ] Typecheck passes

### US-011: Support consistent v2 reads across product surfaces

**Description:** As an operator, I want Admin UI, Web UI, and TUI to read the same v2 state semantics so that status displays match backend truth.

**Acceptance Criteria:**

- [ ] Admin UI, Web UI, and TUI all read from the v2 canonical snapshot or a read model derived from it
- [ ] UI-visible lifecycle state is sourced from `status`, not inferred from `stage`
- [ ] Terminal swarms display `idle` stage only when `status` is terminal
- [ ] Archived swarms remain readable without changing lifecycle semantics
- [ ] Verify-skipped state is shown only when waiver evidence exists in the underlying snapshot
- [ ] Typecheck passes
- [ ] Verify in browser using dev-browser skill

### US-012: Separate archive from purge

**Description:** As an administrator, I want archive and purge to stay distinct so that hiding data is never confused with deleting it.

**Acceptance Criteria:**

- [ ] `archive` changes visibility only and does not change `swarm.status` or `swarm.stage`
- [ ] `unarchive` only clears `swarm.visibility.archived_at`
- [ ] `deleted` is not introduced as any lifecycle state
- [ ] Auto-archive is optional and defaults to off
- [ ] Auto-archive can apply only to `completed | failed | stopped`
- [ ] Auto-purge is not implemented
- [ ] Purge is manual only
- [ ] Purge is allowed only for `completed | failed | stopped` and only when no active worker, verify run, or discussion remains
- [ ] Typecheck passes

### US-013: Roll out through cleanup and reset

**Description:** As a release engineer, I want v2 rollout to depend on cleanup instead of migration so that no mixed legacy state remains.

**Acceptance Criteria:**

- [ ] No legacy compatibility reads are implemented for v2 rollout
- [ ] No legacy backfill path is implemented
- [ ] No migration script converts old swarm data into v2 data
- [ ] Cleanup tooling supports `dry-run`
- [ ] Cleanup tooling shows stats and a list of objects to delete
- [ ] Cleanup tooling requires explicit confirmation before deletion
- [ ] Cleanup tooling runs a post-check that confirms legacy swarm data is cleared
- [ ] v2 rollout is blocked until cleanup completes successfully
- [ ] New swarms created after cleanup start at `schema_version=2`
- [ ] Typecheck passes

## Functional Requirements

- FR-1: The system must store each swarm’s authoritative state in one canonical snapshot file, such as `state.json`
- FR-2: The system must treat the canonical snapshot as the only source of truth for swarm state
- FR-3: The system must define authoritative snapshot fields for `schema_version`, `rev`, `seq`, `swarm.status`, `swarm.stage`, `swarm.resume.stage`, `swarm.visibility.archived_at`, `workers[*].status`, `workers[*].task_id`, `tasks[*].status`, `tasks[*].blocked_by`, `tasks[*].verify_required`, `discussions[*].status`, `discussions[*].current_round`, `verify.status`, `verify.result`, and `audit.last_txn`
- FR-4: The system must treat UI aggregate labels, list caches, admin aggregate caches, debug statistics, and mirrored legacy fields as metadata only
- FR-5: The system must define `Swarm.status` as `active | paused | blocked | completed | failed | stopped`
- FR-6: The system must define `Swarm.stage` as `planning | dispatching | executing | discussing | verifying | repairing | idle`
- FR-7: The system must define `Worker.status` as `queued | starting | running | waiting | blocked | completed | failed | cancelled | stopped`
- FR-8: The system must define `BoardTask.status` as `pending | ready | in_progress | verifying | completed | blocked | failed | cancelled`
- FR-9: The system must define `Discussion.status` as `idle | collecting | round_complete | consensus_ready | decided | exhausted | failed | cancelled`
- FR-10: The system must define `Verify.status` as `idle | pending | running | passed | failed | repair_required | skipped | cancelled`
- FR-11: The system must keep lifecycle `status` and execution `stage` separate
- FR-12: The system must not allow `stage` to represent `completed`, `failed`, or `stopped`
- FR-13: The system must not allow `status` to represent `planning`, `dispatching`, `executing`, `discussing`, `verifying`, `repairing`, or `idle`
- FR-14: The system must require `stage=idle` whenever `Swarm.status` is `completed`, `failed`, or `stopped`
- FR-15: The system must preserve the current execution `stage` while a swarm is `paused` or `blocked`
- FR-16: The system must resume from `paused` back to the exact stored `resume.stage`
- FR-17: The system must allow only the approved `Swarm.status` transitions
- FR-18: The system must allow only the approved `Swarm.stage` transitions
- FR-19: The system must reject `completed -> active`, `failed -> active`, `paused -> completed`, and `blocked -> completed`
- FR-20: The system must not auto-recover a blocked swarm due to time passing
- FR-21: The coordinator must be the only actor allowed to commit authoritative state transitions
- FR-22: The system must treat worker, verify, discussion, and admin actions as observations, artifacts, or commands until the coordinator commits them
- FR-23: The system must record audit information for illegal direct snapshot mutations
- FR-24: The system must allow only the approved `Worker.status` transitions
- FR-25: The system must move a worker from `waiting` to `blocked` after `600s` by default
- FR-26: The system must allow the wait timeout to be overridden through `lark-opencode.json` key `swarm.wait_timeout_seconds`
- FR-27: The system must fall back to `600` seconds when the override is not configured
- FR-28: The system must require explicit unblock evidence before a blocked worker can return to `running`
- FR-29: The system must not unblock a worker based on elapsed time alone
- FR-30: The system must allow at most one non-terminal worker for the same `task_id`
- FR-31: The system must apply the documented worker-to-task state linkage rules
- FR-32: The system must allow only the approved `BoardTask.status` transitions
- FR-33: The system must move a task to `ready` only when all dependencies are `completed`
- FR-34: The system must keep downstream tasks in `pending` when any dependency is `failed`, `cancelled`, or `blocked`
- FR-35: The system must not auto-mark downstream tasks as `blocked` unless the coordinator explicitly writes that state and reason
- FR-36: The system must allow only the approved `Discussion.status` transitions
- FR-37: The system must start `current_round` at `1`
- FR-38: The system must allow only the coordinator to execute `advance_round`
- FR-39: The system must prevent new `collecting` rounds after `current_round == max_rounds`
- FR-40: The system must keep `decided` and `exhausted` mutually exclusive
- FR-41: The system must allow only the approved `Verify.status` transitions
- FR-42: The system must permit `Verify.skipped` only when explicit waiver evidence exists
- FR-43: The system must not derive `Verify.skipped` from legacy data, backfill, inferred logic, or default behavior
- FR-44: The system must keep `swarm.status=active` and `swarm.stage=verifying` while verify is `pending` or `running`
- FR-45: The system must permit swarm completion only when all required tasks are `completed` and verify is `passed`, or `skipped` with explicit waiver evidence
- FR-46: The system must move the swarm into `repairing` when verify is `failed` or `repair_required`
- FR-47: The system must move the swarm into `failed` when repair attempts reach the configured threshold and verify still fails
- FR-48: The system must serialize authoritative commits for a given swarm as a single-writer model
- FR-49: The system must support multi-entity updates in one transaction over the canonical snapshot
- FR-50: The system must commit via temp file, `fsync`, and `rename`
- FR-51: The system must assign a new `rev` and a strictly increasing `seq` on every successful commit
- FR-52: The system must record `reason`, `actor`, `at`, and `txn` for every successful authoritative commit
- FR-53: The system must expose authoritative SSE event types `snapshot` and `transition`
- FR-54: The system must send a full `snapshot` when a client connects
- FR-55: The system must emit `transition` events after each successful transaction
- FR-56: The system must require clients to process SSE events in `seq` order
- FR-57: The system must require clients to de-duplicate repeated `seq` values
- FR-58: The system must require clients to request a fresh snapshot when a `seq` gap is detected
- FR-59: The system must send transition logs to the overall logging system
- FR-60: The system must not treat transition logs as the business source of truth
- FR-61: The system must model archive as visibility-only behavior
- FR-62: The system must ensure archive and unarchive do not change lifecycle or execution stage
- FR-63: The system must not introduce `deleted` as a lifecycle state
- FR-64: The system may support auto-archive, but it must default to off
- FR-65: The system must allow auto-archive only for `completed | failed | stopped`
- FR-66: The system must not implement auto-purge
- FR-67: The system must allow purge only as a manual administrative action
- FR-68: The system must allow purge only for `completed | failed | stopped`
- FR-69: The system must require no active worker, verify, or discussion before purge can proceed
- FR-70: The system must remove the swarm data directory and clean index references during purge
- FR-71: The system must retain minimal audit data for a purged swarm, including `swarm_id`, `purged_at`, `actor`, and `last_status`
- FR-72: The system must not provide legacy compatibility reads for v2 rollout
- FR-73: The system must not provide legacy backfill for v2 rollout
- FR-74: The system must not provide migration scripts that convert old swarm data into v2 state
- FR-75: The system must provide cleanup tooling that supports `dry-run`, explicit confirmation, deletion stats, deletion listing, and post-check validation
- FR-76: The system must block formal v2 rollout until cleanup completes successfully
- FR-77: The system must create all new swarms as `schema_version=2` after cleanup
- FR-78: The system must align SSE, Admin UI, Web UI, and TUI on the same v2 read semantics

## Non-Goals

- Legacy compatibility reads for old swarm data
- Legacy backfill into v2 state
- Migration scripts that convert old swarm data into v2 data
- Distributed multi-coordinator writes to the same swarm
- Changes to task decomposition strategy
- Changes to LLM scheduling strategy
- Auto-purge behavior of any kind
- Introducing `deleted` as a lifecycle state

## Design Considerations

- `status`, `stage`, and `visibility` represent different concerns and must remain separate
- Archived swarms should be hidden from default listings without losing state, artifacts, or logs
- UI consumers should display lifecycle from `status`, not from derived guesses based on `stage`
- A paused or blocked swarm should still show the stage where work stopped
- A verify-skipped swarm must surface waiver evidence clearly in operator-facing views
- Any v2 read model for UI should be reconstructible from the canonical snapshot and authoritative SSE stream

## Technical Considerations

- One swarm maps to one authoritative snapshot file
- Snapshot writes must follow a single-writer model per swarm
- Atomicity depends on temp file write, `fsync`, and `rename`
- `rev` tracks snapshot revision, and `seq` tracks authoritative event ordering
- SSE uses `snapshot + transition` so reconnecting clients can self-heal after missed events
- Transition logs are for audit, debugging, and limited replay only
- Cleanup is a release prerequisite, not a background improvement
- Rollout phases remain:
- Phase 0: define types, state machine rules, storage interfaces, and test matrix without writing production data
- Phase 1: validate cleanup/reset in isolated environments until legacy swarm data is fully cleared
- Phase 2: switch coordinator writes to the canonical snapshot and switch readers to the v2 model
- Phase 3: optionally enable auto-archive while keeping it default-off and never enabling auto-purge

## Success Metrics

- 100% of new v2 swarms use one canonical snapshot as the authoritative source of truth
- 0 known cases where SSE, Admin UI, Web UI, TUI, and stored state disagree on lifecycle state for the same swarm
- 0 paths where `Verify.skipped` is produced without explicit waiver evidence
- 0 paths where blocked entities auto-recover without explicit unblock evidence
- 100% of tested waiting-worker timeout behavior falls back to `600s` when `swarm.wait_timeout_seconds` is absent
- 100% of rollout environments pass cleanup post-checks before v2 activation
- 0 auto-purge executions in production behavior

## Open Questions

None currently.

## Implementation Plan

### 建议顺序

- Phase 0 基础建模：US-001, US-002, US-004
- Phase 1 写入内核：US-003, US-009
- Phase 2 先解长时运行问题：US-005, US-006, US-008
- Phase 3 补齐协作流：US-007, US-010
- Phase 4 统一读取面：US-011
- Phase 5 运维与发布：US-012, US-013

### 分阶段推进

#### Phase 0：定模型

- 先落 `state.json`、`schema_version=2`、`rev/seq` 和最小快照样例，对应 US-001
- 再拆开 `swarm.status` 与 `swarm.stage`，并固化状态矩阵，对应 US-002、US-004
- 这一阶段只产出类型、校验器、状态机规则和测试矩阵，不切生产写路径

**依赖关系**

- US-001 是全部后续故事的根依赖
- US-002 依赖 US-001 的 schema 定义
- US-004 依赖 US-002 的状态字段拆分

**风险说明**

- 这里如果字段语义定错，后面存储、SSE、UI 都会返工
- `status/stage` 边界最容易被旧逻辑继续混用

**验证检查点**

- 类型和 schema 校验通过
- 非法 `status/stage` 组合会被拒绝
- 最小快照可以被读取、校验、序列化

#### Phase 1：收口写入

- 把 authoritative write 收到 coordinator，一切 worker/verify/discussion/admin 先变成 observation 或 command，对应 US-003
- 实现单写者提交管线：读当前快照、构造下一版、校验、临时文件、`fsync`、`rename`，对应 US-009
- 同步补审计字段，保证非法直接写入可追踪

**依赖关系**

- US-003 依赖 US-001、US-002、US-004
- US-009 依赖 US-003，因为先要明确谁能提交 authoritative state

**风险说明**

- 这是最容易引入竞态和写丢失的阶段
- 一旦 coordinator 外仍保留旧写口，会出现双源真相

**验证检查点**

- 同一 swarm 并发提交只允许一个成功写入
- `rev` 每次提交递增，`seq` 严格单调
- `rename` 前失败不污染旧状态，`rename` 后失败仍以磁盘为准

#### Phase 2：先治长时运行

- 先做 worker `waiting -> blocked` 的 600s 默认超时与配置覆盖，对应 US-005
- 再把 task 状态和 worker/verify 联动收紧，避免下游任务误推进，对应 US-006
- 同时把 verify 状态显式化，只允许有 waiver evidence 时跳过，对应 US-008
- 目标是尽快把“挂很久但看不出来”的 swarm 变成“明确 blocked、可审计、可恢复”

**依赖关系**

- US-005 依赖 US-003、US-009，没有单点提交和原子快照很难可靠升级 worker 状态
- US-006 依赖 US-005，因为 task 要映射 worker 结果
- US-008 依赖 US-006，因为 swarm 完成条件取决于 task 和 verify 收敛

**风险说明**

- 超时升级可能误伤慢但正常的 worker，需要配置覆盖和清晰 evidence 模型
- `blocked -> running` 若证据模型不清，会让恢复路径混乱
- verify 规则过晚落地，会让“看似完成”继续漏出

**验证检查点**

- 未配置时 `waiting` 在 600s 后稳定进入 `blocked`
- 配置 `swarm.wait_timeout_seconds` 后行为按配置生效
- 没有 unblock evidence 时，worker 不能自动恢复
- required task 未完成或 verify 未通过时，swarm 不能完成

#### Phase 3：补事件与讨论

- 显式建模 discussion 轮次、终态和 `advance_round` 权限，对应 US-007
- 发布最小 authoritative SSE：连接先发 `snapshot`，提交后发 `transition`，对应 US-010
- 让客户端能按 `seq` 重建状态，并在 gap 时主动拉全量快照

**依赖关系**

- US-007 依赖 Phase 1 的 coordinator-only 提交
- US-010 依赖 US-009，因为 SSE 必须跟 authoritative commit 对齐

**风险说明**

- SSE 若早于磁盘提交发出，会制造读写不一致
- discussion 若不是 coordinator 驱动，会再次回到多点状态变更

**验证检查点**

- 新连接总能拿到可用全量 `snapshot`
- `transition` 严格带 `seq`，重复事件可去重，缺口会触发重拉
- discussion 到达 `max_rounds` 后不再开启新一轮

#### Phase 4：统一读取

- 把 Admin UI、Web UI、TUI 都切到 v2 快照或其只读派生模型，对应 US-011
- UI 只从 `status` 展示生命周期，不再从 `stage` 猜测
- 显式显示 blocked、verify skipped 和 waiver evidence

**依赖关系**

- US-011 依赖 US-010 的 snapshot + transition 读取契约
- 也依赖 US-008，否则 verify 展示语义不稳定

**风险说明**

- UI 最容易偷偷保留旧推断逻辑，造成“后端对，前端错”
- 混用旧列表缓存和新快照会出现瞬时错态

**验证检查点**

- 同一 swarm 在 Admin UI、Web UI、TUI 的状态展示一致
- terminal swarm 只显示 `idle` stage
- skipped verify 只在有 waiver evidence 时显示

#### Phase 5：清理发布

- 实现 archive/unarchive/purge 的独立语义，对应 US-012
- 做 cleanup/reset 工具，禁止 migration/backfill，完成后才允许 v2 rollout，对应 US-013
- 发布时按隔离环境先清理、后启用、再观察

**依赖关系**

- US-012 依赖前面完整 lifecycle 语义稳定
- US-013 依赖前述核心链路可运行，否则 cleanup 后无法承接新数据

**风险说明**

- cleanup 如果不彻底，最容易出现 legacy/v2 混读
- purge 若边界没守住，会误删仍有活动实体的数据

**验证检查点**

- cleanup `dry-run`、确认、删除统计、post-check 全部可用
- cleanup 完成前，v2 创建入口不可开启
- purge 只允许在终态且无活动 worker/verify/discussion 时执行

### 首个切片

- 推荐 MVP：US-001 + US-002 + US-003 + US-009 + US-005 的最小闭环
- 具体做法：先让 coordinator 独占写 `state.json`，再把 worker `waiting -> blocked` 超时提交进快照并写审计
- 先不做完整 UI 改造，只要提供可读快照和基础事件/日志，就能最快暴露“长时间卡住”的 swarm
- 这个切片最早降低当前问题，因为它直接把“无限等待”改成“有默认上限、可见、不可自动自愈”的 blocked 状态
- MVP 完成标志：新 swarm 能生成 v2 快照；等待 worker 会在 600s 后进入 `blocked`；swarm 不再无限保持看似 active 但无进展的长运行状态

## Appendix A: Canonical snapshot shape

```json
{
  "schema_version": 2,
  "rev": 17,
  "seq": 241,
  "swarm": {},
  "workers": {},
  "tasks": {},
  "discussions": {},
  "verify": {},
  "audit": {}
}
```

## Appendix B: Authoritative versus metadata fields

Authoritative fields:

- `schema_version`
- `rev`
- `seq`
- `swarm.status`
- `swarm.stage`
- `swarm.resume.stage`
- `swarm.visibility.archived_at`
- `workers[*].status`
- `workers[*].task_id`
- `tasks[*].status`
- `tasks[*].blocked_by`
- `tasks[*].verify_required`
- `discussions[*].status`
- `discussions[*].current_round`
- `verify.status`
- `verify.result`
- `audit.last_txn`

Metadata only:

- UI aggregate labels
- List caches
- Admin aggregate caches
- Derived debug statistics
- Mirrored legacy fields

## Appendix C: Approved compatibility matrix

| `status`    | Allowed `stage`                                                                        |
| ----------- | -------------------------------------------------------------------------------------- |
| `active`    | `planning`, `dispatching`, `executing`, `discussing`, `verifying`, `repairing`, `idle` |
| `paused`    | `planning`, `dispatching`, `executing`, `discussing`, `verifying`, `repairing`, `idle` |
| `blocked`   | `planning`, `dispatching`, `executing`, `discussing`, `verifying`, `repairing`         |
| `completed` | `idle`                                                                                 |
| `failed`    | `idle`                                                                                 |
| `stopped`   | `idle`                                                                                 |

## Appendix D: Minimal snapshot example

```json
{
  "schema_version": 2,
  "rev": 3,
  "seq": 42,
  "swarm": {
    "id": "sw_1",
    "status": "active",
    "stage": "verifying",
    "visibility": {
      "archived_at": null
    },
    "resume": {
      "stage": "executing"
    },
    "reason": "all_required_tasks_finished"
  },
  "workers": {
    "w_1": {
      "id": "w_1",
      "status": "completed",
      "task_id": "t_1"
    }
  },
  "tasks": {
    "t_1": {
      "id": "t_1",
      "status": "verifying",
      "verify_required": true,
      "blocked_by": []
    }
  },
  "discussions": {},
  "verify": {
    "status": "running",
    "result": null
  },
  "audit": {
    "last_txn": "txn_42"
  }
}
```
