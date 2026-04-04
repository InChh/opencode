# Multi-Agent Swarm 使用指南

多 Agent 并行协作系统，让一群 AI 工人同时完成复杂任务。

---

## 概述

Swarm 是 opencode 内置的多 Agent 协作框架。一个 **Conductor（指挥者）** 负责拆解目标、分配任务、监控进度；多个 **Worker（工人）** 并行执行具体工作。所有协调通过一个共享的 **SharedBoard（看板）** 完成。

```
                           ┌─────────────┐
                           │   用户目标   │
                           └──────┬──────┘
                                  │
                           ┌──────▼──────┐
                           │  Conductor  │
                           │  (指挥者)    │
                           └──┬───┬───┬──┘
                     ┌────────┘   │   └────────┐
                     ▼            ▼            ▼
               ┌──────────┐ ┌──────────┐ ┌──────────┐
               │ Worker A │ │ Worker B │ │ Worker C │
               └────┬─────┘ └────┬─────┘ └────┬─────┘
                    │            │            │
                    └────────────┼────────────┘
                                 ▼
                          ┌────────────┐
                          │ SharedBoard│
                          │   (看板)   │
                          └────────────┘
```

Swarm 复用现有基础设施（Session、Bus、PersistentTask），无需额外进程。Conductor 是一个拥有完整 prompt 的 primary agent，Worker 是独立的 sisyphus session。

---

## 快速开始

### 启用功能

Swarm 由环境变量开关控制，默认关闭：

```bash
export OPENCODE_SWARM=1
```

设置后重启 opencode 即可。

### 添加配置（可选）

在 `opencode.jsonc` 中自定义 Swarm 行为：

```jsonc
{
  "swarm": {
    "max_workers": 4,
    "auto_escalate": true,
    "verify_on_complete": true,
  },
}
```

### 启动第一个 Swarm

在 TUI 中输入：

```
/swarm launch 为项目添加一个完整的用户认证模块，包括注册、登录、JWT token 管理
```

Conductor 会自动拆解任务、分配工人、推进执行。

---

## 核心概念

### Conductor（指挥者）

Conductor 是一个特殊的 primary agent，负责 **规划** 和 **调度**，不直接写代码。

| 属性         | 值                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------- |
| mode         | `primary`                                                                                    |
| temperature  | `0.1`                                                                                        |
| prompt_level | `full`                                                                                       |
| 允许的工具   | `board_read`, `board_write`, `board_status`, `delegate_task`, `bash`, `read`, `grep`, `glob` |
| 拒绝的工具   | `edit`, `write`                                                                              |

Conductor 的 prompt 由两部分组成：

- **Soul**：`conductor.txt` — 身份、价值观、工作协议
- **Strategy**：`strategy-template.md` — 通过 pre-llm hook 注入的规划/分配/冲突处理策略

### Worker（工人）

Worker 是由 Conductor 通过 `delegate_task` 创建的独立 session。每个 Worker 拥有自己的会话上下文，互不干扰。

- 独立 Primary Session（没有 parentID）
- 允许 `board_read`、`board_write` — 可以读写看板
- 拒绝 `swarm_launch` — 防止嵌套创建 Swarm
- 使用 sisyphus agent 执行实际工作

### SharedBoard（共享看板）

SharedBoard 是 Swarm 内所有 Agent 的通信枢纽。数据存储在文件系统中：

```
{data}/projects/{project}/board/{swarm_id}/
├── tasks/
│   ├── BT-{uuid}.json
│   └── ...
├── artifacts/
│   ├── A-{uuid}.json
│   └── ...
└── signals.jsonl
```

看板的读取带有 5 秒 TTL 缓存，Bus 事件会自动失效缓存。

### Task（任务）

BoardTask 是最小的工作单元。

| 字段        | 说明                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `id`        | `BT-{uuid}` 格式                                                     |
| `subject`   | 任务标题                                                             |
| `type`      | `implement` / `review` / `test` / `investigate` / `fix` / `refactor` |
| `status`    | `pending` → `in_progress` → `completed` / `failed` / `cancelled`     |
| `scope`     | 任务涉及的文件路径（用于 ScopeLock）                                 |
| `blockedBy` | 依赖的其他任务 ID                                                    |
| `assignee`  | 负责的 Worker                                                        |

### Artifact（产物）

Worker 执行过程中产生的输出。

| 类型          | 用途         |
| ------------- | ------------ |
| `analysis`    | 代码分析结果 |
| `code_change` | 代码变更记录 |
| `test_result` | 测试结果     |
| `decision`    | 决策记录     |
| `finding`     | 发现和洞察   |
| `checkpoint`  | 执行检查点   |

### Signal（信号）

Worker 和 Conductor 之间的实时消息。存储在 `signals.jsonl`，每行一条 JSON。

| 类型          | 发送方 | 含义        |
| ------------- | ------ | ----------- |
| `progress`    | Worker | 进度更新    |
| `done`        | Worker | 任务完成    |
| `failed`      | Worker | 任务失败    |
| `blocked`     | Worker | 任务被阻塞  |
| `conflict`    | Worker | 文件冲突    |
| `question`    | Worker | 需要确认    |
| `need_review` | Worker | 需要 review |

---

## 使用指南

### 通过 TUI 使用

启用 `OPENCODE_SWARM=1` 后，`/swarm` 命令可用：

```bash
# 启动
/swarm launch 重构整个认证模块，拆分为独立的 auth 包

# 查看状态
/swarm status

# 发送消息给 Conductor
/swarm msg SW-xxx 先暂停 Worker B 的工作，等 A 完成后再继续

# 停止
/swarm stop SW-xxx
```

### 通过 Web Dashboard 使用

Web 界面提供实时的 Swarm 监控面板，路径为 `/swarm/{id}`。面板包含：

- **Header** — 目标、状态徽章、运行时间
- **Controls** — Pause / Resume / Stop 按钮
- **Intervene** — 向 Conductor 发送即时消息
- **Task Graph** — 任务依赖图和进度
- **Worker Cards** — 每个 Worker 的状态
- **Activity Feed** — 实时事件流
- **Attention Queue** — 需要关注的事项

### 通过 Tool 使用

Agent 可以在对话中直接调用 Swarm 工具：

```
// 启动 Swarm
swarm_launch({ goal: "添加用户认证模块", max_workers: 3 })

// 查看状态
swarm_status({ id: "SW-xxx" })

// 干预 Conductor
swarm_intervene({ id: "SW-xxx", message: "优先完成数据库迁移" })

// 读取看板
board_read({ operation: "snapshot", swarm_id: "SW-xxx" })

// 写入看板
board_write({
  operation: "create_task",
  swarm_id: "SW-xxx",
  data: {
    subject: "实现 JWT 中间件",
    type: "implement",
    scope: ["src/middleware/auth.ts"]
  }
})

// 看板概况
board_status({ swarm_id: "SW-xxx" })
```

### 通过 REST API 使用

所有操作都可通过 HTTP 接口调用：

```bash
# 启动 Swarm
curl -X POST http://localhost:4096/swarm \
  -H "Content-Type: application/json" \
  -d '{"goal": "重构认证模块", "config": {"max_workers": 3}}'

# 列出所有 Swarm
curl http://localhost:4096/swarm

# 查看状态
curl http://localhost:4096/swarm/SW-xxx

# 发送消息
curl -X POST http://localhost:4096/swarm/SW-xxx/intervene \
  -H "Content-Type: application/json" \
  -d '{"message": "暂停所有新任务分配"}'

# 暂停 / 恢复 / 停止
curl -X POST http://localhost:4096/swarm/SW-xxx/pause
curl -X POST http://localhost:4096/swarm/SW-xxx/resume
curl -X POST http://localhost:4096/swarm/SW-xxx/stop

# SSE 事件流
curl http://localhost:4096/swarm/SW-xxx/events
```

---

## 配置参考

### 完整配置

```jsonc
{
  "swarm": {
    // 最大并发 Worker 数（默认 4）
    "max_workers": 4,

    // 自动触发升级策略（默认 true）
    "auto_escalate": true,

    // 所有任务完成后运行验证（默认 true）
    "verify_on_complete": true,

    // 自定义升级规则（与默认规则合并）
    "escalation": [
      {
        "condition": "task_failed",
        "action": "retry",
        "max_retries": 5,
      },
      {
        "condition": "conflict_same_file",
        "action": "arbitrate",
        "max_retries": 3,
      },
    ],
  },
}
```

### 配置项说明

| 字段                 | 类型      | 默认值 | 说明                                    |
| -------------------- | --------- | ------ | --------------------------------------- |
| `max_workers`        | `number`  | `4`    | 最大并发 Worker 数量                    |
| `auto_escalate`      | `boolean` | `true` | 任务失败时是否自动触发升级策略          |
| `verify_on_complete` | `boolean` | `true` | 所有任务完成后是否运行 typecheck + 测试 |
| `escalation`         | `Rule[]`  | 见下表 | 自定义升级规则                          |

### 默认升级规则

| condition               | action      | max_retries | 说明                      |
| ----------------------- | ----------- | ----------- | ------------------------- |
| `task_failed`           | `retry`     | 3           | 任务失败后自动重试        |
| `conflict_same_file`    | `arbitrate` | 3           | 文件冲突时 Conductor 仲裁 |
| `architecture_decision` | `ask_human` | 3           | 架构决策升级给人类        |
| `all_retries_exhausted` | `ask_human` | 3           | 重试用尽后升级给人类      |
| `security_sensitive`    | `ask_human` | 3           | 安全相关升级给人类        |

### 升级动作

| action      | 说明                |
| ----------- | ------------------- |
| `retry`     | 重新执行任务        |
| `arbitrate` | Conductor 仲裁冲突  |
| `reassign`  | 分配给另一个 Worker |
| `ask_human` | 升级给人类用户      |

---

## 架构详解

### 生命周期

```
launch()
  │
  ├── 创建 SW-{uuid}
  ├── SharedBoard.init（创建 tasks/ 和 artifacts/ 目录）
  ├── 创建 Conductor session
  ├── 发送 goal 给 Conductor（异步）
  ├── 启动 monitor（监听信号）
  │
  ▼ status: planning
  │
  Conductor 分析目标
  ├── board_write → 创建 BoardTask
  │
  ▼ status: running
  │
  Conductor 分配任务
  ├── delegate_task(swarm_id, task_id) → 创建 Worker session
  ├── Worker 执行 → 产出 artifact，发送 signal
  │
  Monitor 转发 done/failed/blocked/conflict 信号给 Conductor
  │
  Conductor 判断所有任务完成
  ├── 运行 typecheck + 测试（verify_on_complete）
  │
  ▼ status: completed
```

### 数据流

```
用户 ──goal──▶ Swarm.launch() ──prompt──▶ Conductor Session
                                               │
                    ┌──board_write──────────────┤
                    ▼                           │
              SharedBoard                       │──delegate_task──▶ Worker Session
                    │                           │                       │
                    │◀──board_read──────────────┤                       │
                    │                           │                       │
                    │◀──signal/artifact─────────┼───────────────────────┘
                    │                           │
              Monitor ──signal relay──▶ Conductor
                                               │
                                        ┌──────┴──────┐
                                        │  验证通过？   │
                                        └──────┬──────┘
                                        yes    │    no
                                    completed  │  创建 fix 任务
```

### Conductor Prompt 结构

Conductor 的 system prompt 由两层组成：

**Soul（灵魂）** — 来自 `conductor.txt`：

- 身份定义：协调者，不写代码
- 核心价值观：正确性 > 速度、解耦后再并行、最小化人类干预、从经验中学习
- 工具协议：各工具的用途说明
- 工作流程：Plan → Assign → Monitor → Resolve → Verify
- 升级边界：仅在架构/安全决策、重试耗尽、仲裁失败时请求人类

**Strategy（策略）** — 来自 `strategy-template.md`，通过 pre-llm hook 注入：

- Planning Protocol — 目标分解原则
- Assignment Protocol — 任务分配逻辑
- Monitoring Protocol — 信号响应策略
- Scope Decouple Protocol — 文件作用域解耦
- Conflict Resolution — 冲突处理流程
- Verification Protocol — 验证流程

### delegate_task 与 Worker 创建

当 Conductor 调用 `delegate_task` 且参数包含 `swarm_id` 时：

1. **Agent 选择** — 强制使用 sisyphus agent
2. **Session 创建** — 独立 Primary Session（无 parentID），不继承 Conductor 上下文
3. **权限配置**：
   - `board_read` → allow
   - `board_write` → allow
   - `swarm_launch` → deny（防止嵌套 Swarm）
4. **注册** — Worker 信息记录到 `Swarm.workers[]`

### ScopeLock 机制

ScopeLock 是内存级的文件锁，防止多个 Worker 同时修改同一文件。

```
Worker A 领取任务 → scope: ["src/auth.ts", "src/middleware.ts"]
                     │
                     ▼
              ScopeLock.lock(swarm, taskID, scope, agent)
                     │
Worker B 尝试 edit src/auth.ts
                     │
                     ▼
              ScopeLock.check → 返回锁持有者信息
                     │
                     ▼ 抛出错误
              "File src/auth.ts is locked by agent Worker A"
```

锁的生命周期：

- **加锁**：任务分配时，Conductor 在 scope 字段中声明
- **解锁**：任务状态变为 `completed`、`failed` 或 `cancelled` 时自动释放
- **检查**：pre-tool hook 在 `edit` / `write` 操作前检查

### 升级策略

Escalation 模块根据事件类型和重试次数决定下一步动作：

```
事件发生 → Escalation.evaluate({ type, retries })
              │
              ├── task_failed & retries < max → retry
              ├── conflict_same_file → arbitrate
              ├── architecture_decision → ask_human
              ├── security_sensitive → ask_human
              └── retries >= 3 → all_retries_exhausted → ask_human
```

自定义规则优先级高于默认规则（数组前置合并）。

### SwarmStats 与 Playbook

**SwarmStats** 记录每个 Agent 的历史表现：

| 指标               | 说明         |
| ------------------ | ------------ |
| `tasks_completed`  | 完成的任务数 |
| `tasks_failed`     | 失败的任务数 |
| `avg_steps`        | 平均步骤数   |
| `avg_duration_ms`  | 平均耗时     |
| `retry_rate`       | 重试率       |
| `types_completed`  | 按类型完成数 |
| `escalation_count` | 升级次数     |

`SwarmStats.recommend(type)` 根据成功率和任务类型经验推荐最佳 Agent。

**Playbook** 是可复用的策略模板，存储在 `board/playbooks/` 目录下。每个 Playbook 是一个带 frontmatter 的 Markdown 文件，包含 `name`、`trigger`、`version` 等元数据。Conductor 可以引用 Playbook 来处理特定场景。

### SSE 事件流

通过 `GET /swarm/:id/events` 订阅实时事件：

```
event: message
data: {"type": "task.updated", "payload": {...}, "timestamp": 1234567890}

event: message
data: {"type": "artifact.created", "payload": {...}, "timestamp": 1234567891}

event: message
data: {"type": "signal", "payload": {...}, "timestamp": 1234567892}

event: message
data: {"type": "swarm.completed", "payload": {...}, "timestamp": 1234567900}
```

| 事件类型           | 触发条件               |
| ------------------ | ---------------------- |
| `task.updated`     | 任务状态变更           |
| `artifact.created` | 新产物发布             |
| `signal`           | 新信号发送             |
| `swarm.updated`    | Swarm 状态变更         |
| `swarm.completed`  | Swarm 完成（连接关闭） |
| `swarm.failed`     | Swarm 失败（连接关闭） |

### Hook 系统

Swarm 注册了三个 hook：

**1. conductor-strategy-injector**

- 链：`pre-llm`，优先级 `150`
- 仅对 `conductor` agent 生效
- 从 board 目录加载 `conductor-strategy.md`，不存在则从模板复制
- 将策略内容追加到 system prompt

**2. scope-lock-checker**

- 链：`pre-tool`，优先级 `50`
- 仅在 `OPENCODE_SWARM=1` 时生效
- 在 `edit` / `write` 工具执行前检查 ScopeLock
- 如果文件被其他 Agent 锁定，抛出错误阻止操作

**3. checkpoint-publisher**

- 链：`post-tool`，优先级 `200`
- 仅在 `OPENCODE_SWARM=1` 且存在 swarm/task 上下文时生效
- 在 `bash`（typecheck 命令）或 `delegate_task` 成功后自动发布 checkpoint artifact

---

## 最佳实践

### 写好目标

好的目标应该具体、可衡量，让 Conductor 能明确拆解。

```
# 好
为项目添加 i18n 支持：
1. 抽取所有硬编码字符串到 locale 文件
2. 实现语言切换组件
3. 添加中文和英文翻译
4. 确保所有现有测试通过

# 不好
改善项目
```

### 选择合适的场景

Swarm 适合可以拆解为 3 个以上**并行**子任务的工作。不是所有任务都适合。

| 场景                         | 推荐方式 |
| ---------------------------- | -------- |
| 修一个 bug                   | 单 Agent |
| 给函数加类型                 | 单 Agent |
| 多模块重构                   | Swarm    |
| 新功能（前端 + 后端 + 测试） | Swarm    |
| 批量迁移 API                 | Swarm    |

### 管理文件作用域

**最重要的原则：并行任务不要修改同一个文件。**

Conductor 会尝试通过 scope 字段解耦，但你可以在目标描述中显式声明模块边界。如果两个任务确实需要改同一个文件，让 Conductor 先创建一个 "接口定义" 任务，完成后再并行后续任务。

### 监控与干预

- Web Dashboard 提供实时视图，推荐在复杂 Swarm 中使用
- 用 `intervene` 随时给 Conductor 发送指令修正方向
- 如果某个 Worker 卡住，Conductor 会收到 blocked 信号并自动处理
- 用 `pause` 暂停所有 Worker，检查中间状态后再 `resume`

### 错误恢复

- 任务失败会自动重试（默认 3 次）
- 重试耗尽后升级给人类
- 用 `intervene` 告诉 Conductor 如何处理特定失败
- 极端情况下用 `stop` 终止整个 Swarm

### 起步建议

对不熟悉的代码库，从 `max_workers: 2` 开始。观察 Conductor 的拆解质量和 Worker 的执行情况，逐步增加并发数。

---

## 故障排除

### Swarm 相关工具不可用

**原因**：`OPENCODE_SWARM` 环境变量未设置。

```bash
export OPENCODE_SWARM=1
# 重启 opencode
```

### Conductor 不写代码

**这是正常行为。** Conductor 的 `edit` 和 `write` 工具被禁用，它只负责协调。所有代码工作由 Worker 完成。

### Worker 之间文件冲突

**原因**：两个 Worker 的 scope 有重叠。

**解决**：通过 `intervene` 告诉 Conductor 重新规划 scope，或手动 pause 后调整任务分配。ScopeLock 会阻止实际的冲突写入。

### 任务一直处于 pending 状态

**原因**：任务有未完成的依赖（`blockedBy`），或 Worker 数量已达上限。

**检查**：

```bash
# 查看看板状态
curl http://localhost:4096/swarm/SW-xxx

# 或在 TUI 中
/swarm status
```

### Swarm 状态卡在 planning

**原因**：Conductor session 可能遇到错误。

**检查**：查看 Conductor session 的日志输出。必要时 `stop` 并重新 `launch`。

### 验证阶段失败

**原因**：Worker 的代码变更引入了类型错误或测试失败。

**处理**：Conductor 会自动创建 fix 任务。如果反复失败，会升级给人类。你也可以 `intervene` 指定修复策略。

---

## API 参考

### Tool Schema

#### swarm_launch

```ts
{
  goal: string       // Swarm 要完成的目标
  max_workers?: number  // 最大并发 Worker 数
}
```

返回 `Swarm.Info` 对象。

#### swarm_status

```ts
{
  id: string // Swarm ID
}
```

#### swarm_intervene

```ts
{
  id: string // Swarm ID
  message: string // 发送给 Conductor 的消息
}
```

#### swarm_stop

```ts
{
  id: string // Swarm ID
}
```

#### swarm_list

无参数。返回所有 Swarm 列表。

#### board_read

```ts
{
  operation: "tasks" | "artifacts" | "signals" | "snapshot"
  swarm_id: string
  filter?: {
    task_id?: string
    type?: string
    author?: string
    channel?: string
    limit?: number
  }
}
```

#### board_write

```ts
{
  operation: "create_task" | "update_task" | "post_artifact" | "signal"
  swarm_id: string
  data: Record<string, unknown>
}
```

`create_task` 的 data：

```ts
{
  subject: string
  description?: string
  type: "implement" | "review" | "test" | "investigate" | "fix" | "refactor"
  scope?: string[]      // 文件路径
  blockedBy?: string[]   // 依赖的任务 ID
  blocks?: string[]      // 被此任务阻塞的任务 ID
  assignee?: string
}
```

`update_task` 的 data：

```ts
{
  id: string            // 任务 ID（必填）
  status?: string
  assignee?: string
  scope?: string[]
  // ...任意 BoardTask.Info 字段
}
```

`post_artifact` 的 data：

```ts
{
  type: "analysis" | "code_change" | "test_result" | "decision" | "finding" | "checkpoint"
  task_id: string
  author: string
  content: string
  files?: string[]
  supersedes?: string   // 替代的旧 artifact ID
}
```

`signal` 的 data：

```ts
{
  channel?: string      // 默认 "general"
  type: "progress" | "conflict" | "question" | "done" | "blocked" | "need_review" | "failed"
  from: string
  payload: Record<string, unknown>
}
```

#### board_status

```ts
{
  swarm_id: string
}
```

返回简洁的文本摘要：任务统计 + 活跃 Worker 数。

### REST 端点

| 方法   | 路径                   | 说明               |
| ------ | ---------------------- | ------------------ |
| `POST` | `/swarm`               | 启动 Swarm         |
| `GET`  | `/swarm`               | 列出所有 Swarm     |
| `GET`  | `/swarm/:id`           | 获取 Swarm 状态    |
| `POST` | `/swarm/:id/intervene` | 发消息给 Conductor |
| `POST` | `/swarm/:id/pause`     | 暂停 Swarm         |
| `POST` | `/swarm/:id/resume`    | 恢复 Swarm         |
| `POST` | `/swarm/:id/stop`      | 停止 Swarm         |
| `GET`  | `/swarm/:id/events`    | SSE 事件流         |

### Bus 事件

| 事件                     | payload                            |
| ------------------------ | ---------------------------------- |
| `swarm.created`          | `{ swarm: Swarm.Info }`            |
| `swarm.updated`          | `{ swarm: Swarm.Info }`            |
| `swarm.completed`        | `{ swarm: Swarm.Info }`            |
| `swarm.failed`           | `{ swarm: Swarm.Info }`            |
| `board.task.created`     | `{ task: BoardTask.Info }`         |
| `board.task.updated`     | `{ task: BoardTask.Info }`         |
| `board.task.deleted`     | `{ id: string, swarm_id: string }` |
| `board.artifact.created` | `{ artifact: BoardArtifact.Info }` |
| `board.signal`           | `{ signal: BoardSignal.Info }`     |

### Swarm.Info 结构

```ts
{
  id: string                     // SW-{uuid}
  goal: string                   // 用户目标
  conductor: string              // Conductor session ID
  workers: Array<{
    session_id: string
    agent: string
    task_id: string
    status: "active" | "idle" | "done" | "failed"
  }>
  config: {
    max_workers: number
    auto_escalate: boolean
    verify_on_complete: boolean
  }
  status: "planning" | "running" | "paused" | "completed" | "failed"
  time: {
    created: number              // Unix 毫秒时间戳
    updated: number
    completed?: number
  }
}
```
