# Multi-Agent Swarm 使用指南

多 Agent 协作框架，支持并行任务执行与结构化角色讨论。

---

## 概述

Swarm 是 opencode 内置的多 Agent 协作框架，提供两种工作模式：

- **任务执行模式** — 一个 Conductor 拆解目标，多个 Worker 并行完成具体工作
- **讨论模式** — 多个角色（PM、RD、QA 等）围绕一个议题展开结构化辩论，最终形成决策

两种模式共享同一套基础设施。核心原则：Worker 之间不直接通信，所有协调通过 SharedBoard 完成（星型拓扑）。

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
             │ (或角色)  │ │ (或角色)  │ │ (或角色)  │
             └────┬─────┘ └────┬─────┘ └────┬─────┘
                  │            │            │
                  └────────────┼────────────┘
                               ▼
                        ┌────────────┐
                        │ SharedBoard│
                        │   (看板)   │
                        └────────────┘
```

Swarm 复用现有基础设施（Session、Bus、PersistentTask），无需额外进程。Conductor 是拥有完整 prompt 的 primary agent，Worker 是独立的 sisyphus session。

---

## 快速开始

### 启用功能

Swarm 由环境变量开关控制，默认关闭：

```bash
export OPENCODE_SWARM=1
```

设置后重启 opencode 即可。可选地在 `opencode.jsonc` 中自定义行为：

```jsonc
{
  "swarm": {
    "max_workers": 4,
    "auto_escalate": true,
    "verify_on_complete": true,
  },
}
```

### 模式一：任务执行

在 TUI 中输入：

```
/swarm launch 为项目添加一个完整的用户认证模块，包括注册、登录、JWT token 管理
```

Conductor 会自动拆解任务、分配工人、推进执行。多个 Worker 并行完成各自的子任务，最终 Conductor 汇总并验证。

### 模式二：角色讨论

在 TUI 中输入：

```
/swarm discuss 我们应该选择 GraphQL 还是 REST 作为 API 方案
```

系统默认分配 PM、RD、QA 三个角色。每个角色从自己的视角提出方案、互相回应，经过多轮讨论后形成最终决策。

也可以自定义角色：

```
swarm_discuss({
  topic: "微服务 vs 单体架构",
  roles: [
    { name: "Architect", perspective: "关注系统可扩展性和长期演进" },
    { name: "DevOps", perspective: "关注部署复杂度和运维成本" },
    { name: "PM", perspective: "关注交付速度和团队能力匹配" }
  ],
  max_rounds: 3
})
```

---

## 核心概念

### Conductor（指挥者）

Conductor 是一个特殊的 primary agent，负责 **规划** 和 **调度**，不直接写代码。在讨论模式中，它还充当主持人角色，推进轮次、总结发言、做出最终裁决。

| 属性         | 值                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------- |
| mode         | `primary`                                                                                    |
| temperature  | `0.1`                                                                                        |
| prompt_level | `full`                                                                                       |
| 允许的工具   | `board_read`, `board_write`, `board_status`, `delegate_task`, `bash`, `read`, `grep`, `glob` |
| 拒绝的工具   | `edit`, `write`                                                                              |

Conductor 的 prompt 由两层（或三层）组成：

- **Soul** — `conductor.txt`：身份、价值观、工作协议
- **Strategy** — `strategy-template.md`：通过 pre-llm hook 注入的规划/分配/冲突处理策略
- **Discussion Protocol**（仅讨论模式）— `conductor-discussion.txt`：讨论协议，包含轮次管理、信号格式、共识判定规则

### Worker（工人）

Worker 是由 Conductor 通过 `delegate_task` 创建的独立 session。每个 Worker 拥有自己的会话上下文，互不干扰。

- 独立 Primary Session（没有 parentID），不继承 Conductor 上下文
- 允许 `board_read`、`board_write` — 可以读写看板
- 拒绝 `swarm_launch` — 防止嵌套创建 Swarm
- 使用 sisyphus agent 执行实际工作

在讨论模式中，Worker 还拥有 **角色名称**（如 PM、RD、QA）和 **视角描述**，引导其从特定立场发言。Conductor 通过 `delegate_task` 的 `role_name` 和 `discussion_channel` 参数绑定角色。

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
├── discussion/
│   ├── {channel}.json          ← 讨论轮次状态
│   └── ...
└── signals.jsonl
```

看板的读取带有 5 秒 TTL 缓存，Bus 事件会自动失效缓存。

### Task 类型

BoardTask 是最小的工作单元。

| 类型          | 用途                     |
| ------------- | ------------------------ |
| `implement`   | 实现新功能               |
| `review`      | 代码审查                 |
| `test`        | 编写或运行测试           |
| `investigate` | 调查分析                 |
| `fix`         | 修复问题                 |
| `refactor`    | 重构代码                 |
| `discuss`     | 讨论议题（讨论模式专用） |

### Artifact 类型

Worker 执行过程中产生的输出。

| 类型             | 用途         |
| ---------------- | ------------ |
| `analysis`       | 代码分析结果 |
| `code_change`    | 代码变更记录 |
| `test_result`    | 测试结果     |
| `decision`       | 决策记录     |
| `finding`        | 发现和洞察   |
| `checkpoint`     | 执行检查点   |
| `proposal`       | 提案文档     |
| `review_comment` | 评审意见     |
| `summary`        | 总结报告     |

### Signal 类型

Signal 是 Worker 和 Conductor 之间的实时消息，存储在 `signals.jsonl`，每行一条 JSON。分为两类：

**执行信号**（任务执行模式）：

| 类型          | 发送方 | 含义        |
| ------------- | ------ | ----------- |
| `progress`    | Worker | 进度更新    |
| `done`        | Worker | 任务完成    |
| `failed`      | Worker | 任务失败    |
| `blocked`     | Worker | 任务被阻塞  |
| `conflict`    | Worker | 文件冲突    |
| `question`    | Worker | 需要确认    |
| `need_review` | Worker | 需要 review |

**讨论信号**（讨论模式）：

| 类型        | 发送方 | 含义                            |
| ----------- | ------ | ------------------------------- |
| `proposal`  | Worker | 提出方案（Round 1）             |
| `opinion`   | Worker | 发表意见（Round 2+）            |
| `objection` | Worker | 提出异议（Round 2+）            |
| `consensus` | Worker | 表态：agree / disagree / modify |

讨论信号的 `from` 字段必须使用角色名（如 `"PM"`），`payload` 中应包含 `round`（轮次号）和 `summary`（内容摘要）。

### Discussion Round（讨论轮次）

讨论模式的核心追踪机制。每个讨论频道维护一个 Round 状态：

```ts
{
  round: number          // 当前轮次
  max_rounds: number     // 最大轮次（默认 3）
  channel: string        // 频道名称
  swarm_id: string       // 所属 Swarm
  expected: string[]     // 预期参与者列表
  received: string[]     // 已发言参与者
  complete: boolean      // 当前轮次是否完成
}
```

围绕 Round 的核心操作：

| 方法                   | 说明                                           |
| ---------------------- | ---------------------------------------------- |
| `Discussion.start()`   | 初始化讨论，创建 Round 1                       |
| `Discussion.join()`    | 动态注册参与者（Worker 创建时自动调用）        |
| `Discussion.record()`  | 记录发言，使用写锁保证原子性，检测轮次是否完成 |
| `Discussion.advance()` | 推进到下一轮，清空 `received`，重置 `complete` |
| `Discussion.tally()`   | 统计共识投票结果                               |
| `Discussion.status()`  | 查询当前轮次状态                               |

共识投票结果（Tally）结构：

```ts
{
  agree: number // 同意人数
  disagree: number // 反对人数
  modify: number // 建议修改人数
  total: number // 总投票数
  unanimous: boolean // 是否全票同意
  positions: Array<{
    from: string // 角色名
    position: string // agree / disagree / modify
    summary: string // 立场摘要
  }>
}
```

---

## 两种模式详解

### 任务执行模式

```
用户设定目标
  │
  ▼
Conductor 分析 → 创建 BoardTask（含依赖关系）
  │
  ▼
Conductor 分配 → delegate_task(swarm_id, task_id) → 创建 Worker
  │
  ├─▶ Worker A 执行 → 产出 artifact → 发送 signal
  ├─▶ Worker B 执行 → 产出 artifact → 发送 signal
  └─▶ Worker C 执行 → 产出 artifact → 发送 signal
  │
  ▼
Monitor 监听信号 → 转发 done/failed/blocked/conflict 给 Conductor
  │
  ▼
Conductor 判断所有任务完成 → 运行 typecheck + 测试（verify_on_complete）
  │
  ▼
status: completed
```

典型流程：

1. 用户输入目标，Conductor 拆解为多个 BoardTask，声明依赖关系和文件作用域
2. Conductor 通过 `delegate_task` 将任务分配给 Worker，每个 Worker 是独立的 sisyphus session
3. Worker 执行工作，通过 `board_write` 发布 artifact 和 signal
4. Monitor 监听信号，将关键事件（完成、失败、冲突等）转发给 Conductor
5. Conductor 收到所有 done 信号后，运行验证（typecheck + 测试），标记完成

### 讨论模式

```
用户提供议题 + 角色
  │
  ▼
Swarm.discuss() → launch() + Discussion.start()
  │
  ▼ Round 1：提案

Conductor 创建 discuss 任务
  ├─▶ delegate_task(role_name="PM", discussion_channel, run_in_background=true)
  ├─▶ delegate_task(role_name="RD", discussion_channel, run_in_background=true)
  └─▶ delegate_task(role_name="QA", discussion_channel, run_in_background=true)
  │
  各 Worker 读取频道 → 发布 proposal 信号
  Discussion.join() 自动注册参与者
  Discussion.record() 追踪发言
  │
  Monitor 检测轮次完成 → "[Discussion Round 1 Complete]" 消息给 Conductor
  │
  ▼ Round 2+：回应

Conductor 调用 board_write advance_round → Discussion.advance()
  ├─▶ delegate_task(session_id=复用, role_name="PM") ← 复用已有 session
  ├─▶ delegate_task(session_id=复用, role_name="RD")
  └─▶ delegate_task(session_id=复用, role_name="QA")
  │
  discussion-thread-injector hook 注入完整讨论线程到 Worker 上下文
  各 Worker 阅读他人发言 → 发布 opinion / objection 信号
  │
  Monitor 检测轮次完成 → "[Discussion Round 2 Complete]" 消息给 Conductor
  │
  ▼ 最终轮：共识

各 Worker 发布 consensus 信号（position: agree / disagree / modify）
  │
  Discussion.tally() 统计投票
  │
  ├─ 全票同意 → 自动形成决策
  └─ 非全票 → Conductor 做最终裁决，记录不同意见
  │
  ▼
Conductor 发布 decision artifact → status: completed
```

关键协议规则：

- Conductor **必须** 等待 Monitor 发送 `[Discussion Round N Complete]` 消息后才推进下一轮
- Worker 在信号的 `from` 字段中使用角色名（如 `"PM"`，而非 session ID）
- 通过 `session_id` 复用 Worker session，保持跨轮次的对话上下文
- `discussion-thread-injector` hook 在每次 LLM 调用前注入完整讨论线程，确保 Worker 看到所有人的发言

---

## 使用指南

### 通过 TUI 使用

启用 `OPENCODE_SWARM=1` 后，`/swarm` 命令可用：

```bash
# 任务执行
/swarm launch 重构整个认证模块，拆分为独立的 auth 包

# 角色讨论
/swarm discuss 我们应该用 WebSocket 还是 SSE 做实时通知

# 查看状态
/swarm status

# 发送消息给 Conductor
/swarm msg SW-xxx 先暂停 Worker B 的工作，等 A 完成后再继续

# 停止
/swarm stop SW-xxx
```

### 通过 Web Dashboard 使用

Web 界面提供实时的 Swarm 监控面板，路径为 `/swarm/{id}`。

**任务执行模式面板**包含：

- **Header** — 目标、状态徽章、运行时间
- **Controls** — Pause / Resume / Stop 按钮
- **Intervene** — 向 Conductor 发送即时消息
- **Task Graph** — 任务依赖图和进度
- **Worker Cards** — 每个 Worker 的状态
- **Activity Feed** — 实时事件流
- **Attention Queue** — 需要关注的事项

**讨论模式面板**将 Task Graph 替换为 Discussion Thread：

- **Header** — 议题名称 + 轮次进度（Round 2/3）+ 参与者状态标记（已发言/未发言）
- **Discussion Thread** — 按轮次分组的讨论卡片，每张卡片显示角色名、信号类型、发言摘要
- **Decision Card** — 讨论结束后显示最终决策和投票统计

### 通过 Tool 使用

Agent 可以在对话中直接调用 Swarm 工具：

```ts
// 启动任务执行 Swarm
swarm_launch({ goal: "添加用户认证模块", max_workers: 3 })

// 启动讨论 Swarm
swarm_discuss({
  topic: "GraphQL vs REST",
  roles: [
    { name: "PM", perspective: "关注用户价值和交付速度" },
    { name: "RD", perspective: "关注技术复杂度和可维护性" },
    { name: "QA", perspective: "关注可测试性和稳定性" },
  ],
  max_rounds: 3,
})

// 查看状态
swarm_status({ id: "SW-xxx" })

// 干预 Conductor
swarm_intervene({ id: "SW-xxx", message: "优先完成数据库迁移" })

// 停止 Swarm
swarm_stop({ id: "SW-xxx" })

// 列出所有 Swarm
swarm_list()
```

看板工具（含讨论操作）：

```ts
// 读取看板快照
board_read({ operation: "snapshot", swarm_id: "SW-xxx" })

// 读取讨论状态
board_read({
  operation: "discussion",
  swarm_id: "SW-xxx",
  filter: { channel: "discuss-a1b2c3d4" },
})

// 推进讨论轮次
board_write({
  operation: "advance_round",
  swarm_id: "SW-xxx",
  data: { channel: "discuss-a1b2c3d4" },
})

// 创建任务
board_write({
  operation: "create_task",
  swarm_id: "SW-xxx",
  data: {
    subject: "实现 JWT 中间件",
    type: "implement",
    scope: ["src/middleware/auth.ts"],
  },
})

// 发送信号
board_write({
  operation: "signal",
  swarm_id: "SW-xxx",
  data: {
    channel: "discuss-a1b2c3d4",
    type: "proposal",
    from: "PM",
    payload: { round: 1, summary: "建议采用 REST 方案" },
  },
})

// 看板概况
board_status({ swarm_id: "SW-xxx" })
```

### 通过 REST API 使用

所有操作都可通过 HTTP 接口调用：

```bash
# 启动任务执行 Swarm
curl -X POST http://localhost:4096/swarm \
  -H "Content-Type: application/json" \
  -d '{"goal": "重构认证模块", "config": {"max_workers": 3}}'

# 启动讨论 Swarm
curl -X POST http://localhost:4096/swarm/discuss \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "GraphQL vs REST",
    "roles": [
      {"name": "PM", "perspective": "关注用户价值"},
      {"name": "RD", "perspective": "关注技术复杂度"}
    ],
    "max_rounds": 3
  }'

# 列出所有 Swarm
curl http://localhost:4096/swarm

# 查看状态
curl http://localhost:4096/swarm/SW-xxx

# 查看讨论状态
curl http://localhost:4096/swarm/SW-xxx/discussion

# 发送消息给 Conductor
curl -X POST http://localhost:4096/swarm/SW-xxx/intervene \
  -H "Content-Type: application/json" \
  -d '{"message": "要求所有角色重点讨论性能影响"}'

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

## Agent 与角色配置

Swarm 中的每个 Agent（Conductor 和 Worker）都可以进行精细配置。了解 Agent 系统是深度定制 Swarm 行为的关键。

### Agent 配置体系

opencode 的 Agent 分为三类：

| 类别         | 来源                        | 说明                                                                         |
| ------------ | --------------------------- | ---------------------------------------------------------------------------- |
| 内置 Agent   | 代码中定义                  | sisyphus、conductor、oracle、explore 等                                      |
| 可选 Agent   | 代码中定义，需手动启用      | hephaestus、atlas、librarian 等，在配置中设置 `options.enabled: true` 后生效 |
| 自定义 Agent | `.opencode/agent/*.md` 文件 | 项目级自定义 Agent；也可放在 `~/.config/opencode/agent/*.md` 作为全局 Agent  |

### 通过配置文件覆盖 Agent 属性

在 `opencode.jsonc` 的 `agent` 字段中，可以覆盖任何已有 Agent 的属性，或定义新的 Agent：

```jsonc
{
  "agent": {
    // 覆盖内置 Agent 属性
    "sisyphus": {
      "model": "anthropic/claude-opus-4-6",
      "temperature": 0.2,
    },

    // 覆盖 Conductor 属性
    "conductor": {
      "model": "anthropic/claude-opus-4-6",
      "temperature": 0.05,
    },

    // 启用可选 Agent
    "hephaestus": {
      "options": { "enabled": true },
    },

    // 禁用不需要的 Agent
    "oracle": {
      "disable": true,
    },

    // 定义新的自定义 Agent
    "db-expert": {
      "description": "数据库专家，专注 SQL 优化和 schema 设计",
      "mode": "subagent",
      "model": "openai/gpt-4.1",
      "prompt": "你是一个数据库专家，擅长 SQL 优化、schema 设计和数据库迁移。",
      "permission": {
        "*": "deny",
        "bash": "allow",
        "read": "allow",
        "grep": "allow",
        "glob": "allow",
      },
    },
  },
}
```

**可覆盖的完整字段列表**：

| 字段            | 类型                               | 说明                                                      |
| --------------- | ---------------------------------- | --------------------------------------------------------- |
| `model`         | `string`                           | `"provider/model"` 格式，如 `"anthropic/claude-opus-4-6"` |
| `temperature`   | `number`                           | 模型温度，0-1                                             |
| `top_p`         | `number`                           | Top-p 采样                                                |
| `prompt`        | `string`                           | 自定义 system prompt                                      |
| `prompt_level`  | `"full" \| "medium" \| "lite"`     | 系统 prompt 注入级别（见下文）                            |
| `description`   | `string`                           | Agent 描述                                                |
| `mode`          | `"primary" \| "subagent" \| "all"` | 工作模式                                                  |
| `permission`    | `Record<string, string>`           | 工具权限覆盖                                              |
| `tools_include` | `string[]`                         | 工具白名单，支持 `"server/*"` 通配符                      |
| `steps`         | `number`                           | 最大 agentic 迭代次数                                     |
| `color`         | `string`                           | 显示颜色（hex 或主题色名）                                |
| `hidden`        | `boolean`                          | 是否在 @ 自动补全中隐藏                                   |
| `disable`       | `boolean`                          | 设为 `true` 移除此 Agent                                  |
| `options`       | `Record<string, any>`              | 扩展选项，如 `{ enabled: true }` 启用可选 Agent           |

### 通过 Markdown 文件定义自定义 Agent

在 `.opencode/agent/` 目录下创建 `.md` 文件，YAML frontmatter 定义配置，Markdown 正文作为 system prompt：

```markdown
---
description: "安全审查专家，审查代码中的安全漏洞"
mode: subagent
temperature: 0.1
permission:
  "*": deny
  read: allow
  grep: allow
  glob: allow
  bash: allow
---

你是一个安全审查专家。你的职责是：

1. 审查代码中的安全漏洞（SQL 注入、XSS、CSRF 等）
2. 检查依赖库的已知漏洞
3. 验证认证和授权逻辑
4. 检查敏感数据的处理方式

不要修改代码，只输出审查报告。
```

也可以使用 CLI 快速创建：

```bash
opencode agent create
```

系统会引导你设置描述、权限、模式，并用 LLM 生成初始 prompt。

### prompt_level：系统 prompt 注入级别

`prompt_level` 控制每次 LLM 调用时系统 prompt 中包含的环境信息量：

| 级别     | 环境信息 | AGENTS.md 等指令文件 | Memory 注入 | 适用场景                        |
| -------- | -------- | -------------------- | ----------- | ------------------------------- |
| `full`   | ✅       | ✅                   | ✅          | 主 Agent（sisyphus、conductor） |
| `medium` | ✅       | ❌                   | ✅          | 子 Agent（explore、oracle）     |
| `lite`   | ❌       | ❌                   | ❌          | 内部 Agent（compaction、title） |

- **环境信息**：工作目录、Git 状态、平台、日期、模型名称
- **指令文件**：项目根目录的 `AGENTS.md`、`.opencode/rules/*.md` 等
- **Memory 注入**：之前通过 `memory_remember` 保存的记忆

降低 `prompt_level` 可以显著减少 token 消耗，适合不需要完整项目上下文的子任务。

### Swarm 中 Worker 的 Agent 配置

#### 任务执行模式

默认情况下，Conductor 创建的 Worker 使用 **sisyphus** agent。Conductor 可以在 `delegate_task` 中通过 `subagent_type` 指定其他 Agent：

```ts
delegate_task({
  description: "审查 auth 模块安全性",
  prompt: "审查 src/auth/ 目录下所有文件的安全漏洞...",
  subagent_type: "security-reviewer", // 使用自定义 Agent
  swarm_id: "SW-xxx",
  task_id: "BT-xxx",
  run_in_background: true,
})
```

Worker 的权限在创建时自动叠加：

- `board_read` → allow（读取看板）
- `board_write` → allow（写入看板）
- `swarm_launch` → deny（禁止嵌套 Swarm）

这些权限叠加在 Agent 自身的权限之上。

#### 讨论模式

讨论模式中，所有 Worker 统一使用 **sisyphus** agent。角色差异完全来自以下两个要素：

1. **`role_name`** — 角色的唯一标识（如 PM、RD、QA），用于 `Discussion.join()`/`record()`/`tally()` 的参与者追踪，以及信号的 `from` 字段
2. **`perspective`** — 角色的视角描述，由 Conductor 写入 Worker 的 prompt 中，引导 Worker 从特定立场发言

```ts
// Conductor 在 delegate_task 时传入 role_name 和 discussion_channel
delegate_task({
  description: "PM discusses API design",
  prompt: "你的角色名是 PM。你的视角：关注用户价值和交付速度。\n读取讨论频道，发布你的提案...",
  role_name: "PM", // 注册为讨论参与者
  discussion_channel: "discuss-a1b2c3d4", // 绑定讨论频道
  run_in_background: true,
})
```

### 自定义讨论角色

`Swarm.discuss()` 支持完全自定义角色。每个角色包含两个字段：

| 字段          | 必填 | 说明                                                     |
| ------------- | ---- | -------------------------------------------------------- |
| `name`        | 是   | 角色唯一标识。简短（1-3 个词），用于信号追踪和 UI 展示   |
| `perspective` | 是   | 角色视角描述。越具体越好，引导 Worker 从该立场思考和发言 |

**设计好角色的关键**：`perspective` 要包含该角色 **关注什么** 和 **倾向什么**，让不同角色产生有价值的观点碰撞。

**示例：技术选型讨论**

```ts
swarm_discuss({
  topic: "新项目应该用 Next.js 还是 Remix",
  roles: [
    { name: "PM", perspective: "关注开发速度、社区生态和招聘难度" },
    { name: "FE", perspective: "关注开发体验、数据获取模式和类型安全" },
    { name: "DevOps", perspective: "关注部署复杂度、CDN 缓存和监控可观察性" },
  ],
  max_rounds: 3,
})
```

**示例：安全方案评审**

```ts
swarm_discuss({
  topic: "OAuth2 vs Session-based 认证方案",
  roles: [
    { name: "Security", perspective: "关注攻击面、token 泄露风险和密钥管理" },
    { name: "Backend", perspective: "关注实现复杂度、第三方集成和横向扩展" },
    { name: "Mobile", perspective: "关注 token 刷新、离线支持和用户体验" },
    { name: "PM", perspective: "关注用户流失率、合规要求和上线时间" },
  ],
  max_rounds: 4, // 安全议题需要更多轮讨论
})
```

**示例：数据库迁移方案**

```ts
swarm_discuss({
  topic: "PostgreSQL 单库 vs 分库分表 vs 迁移到 TiDB",
  roles: [
    { name: "DBA", perspective: "关注查询性能、分片策略和运维复杂度" },
    { name: "RD", perspective: "关注 ORM 兼容性、事务语义和迁移成本" },
    { name: "SRE", perspective: "关注高可用、备份恢复和资源成本" },
  ],
})
```

### Conductor Prompt 定制

Conductor 的 system prompt 由三层组成，逐层追加：

```
┌──────────────────────────────────────────────────┐
│ 1. Soul — conductor.txt                          │
│    身份、价值观、工具协议、工作流程、升级边界     │
├──────────────────────────────────────────────────┤
│ 2. Strategy — conductor-strategy.md              │
│    规划、分配、监控、解耦、冲突、验证协议         │
│    首次运行时从 strategy-template.md 复制         │
│    存储在 board/ 目录，可手动编辑                 │
├──────────────────────────────────────────────────┤
│ 3. Discussion Protocol — conductor-discussion.txt│
│    仅讨论模式：轮次管理、信号格式、共识规则       │
│    当 board 中存在 discuss 任务时自动注入         │
└──────────────────────────────────────────────────┘
```

**定制 Strategy 层**：

Strategy 文件存储在 `{data}/projects/{project}/board/conductor-strategy.md`。首次运行时从内置模板复制。你可以直接编辑该文件来调整 Conductor 的行为策略：

```markdown
## Planning Protocol

1. 分析目标，识别所有子任务
2. 每个任务最多涉及 3 个文件（减少 scope 冲突）
3. 优先创建接口定义任务，后续实现任务依赖它

## Assignment Protocol

1. 使用 board_status 检查可用 Worker 数
2. 优先分配无依赖的就绪任务
3. 检测到 scope 重叠时，创建 refactor 任务先解耦

## Monitoring Protocol

1. 收到 done 信号后立即检查 board_status
2. 发现 idle Worker 超过 30 秒，发送催促信号
3. 连续 3 次失败同一任务，升级给人类

## Verification Protocol

1. 所有任务完成后运行 typecheck
2. typecheck 失败则创建 fix 任务
3. 所有验证通过后标记 Swarm completed
```

**覆盖 Conductor 模型**：

Conductor 默认跟随用户当前选择的模型。对于复杂的协调工作，建议使用更强的模型：

```jsonc
{
  "agent": {
    "conductor": {
      "model": "anthropic/claude-opus-4-6",
      "temperature": 0.05,
    },
  },
}
```

### 内置 Agent 速查

以下是 Swarm 相关的内置 Agent 一览：

| Agent          | 模式     | 温度 | prompt_level | 说明                         |
| -------------- | -------- | ---- | ------------ | ---------------------------- |
| `sisyphus`     | primary  | 0.1  | full         | 主力 Agent，Worker 默认使用  |
| `conductor`    | primary  | 0.1  | full         | Swarm 指挥者，不写代码只协调 |
| `general`      | subagent | —    | medium       | 通用子 Agent，适合多步骤任务 |
| `explore`      | subagent | —    | medium       | 代码探索，只读权限           |
| `omo-explore`  | subagent | —    | medium       | 深度探索，含 LSP 和 AST 工具 |
| `oracle`       | subagent | 0.1  | medium       | 策略顾问，只读分析           |
| `hephaestus`\* | subagent | —    | —            | 全权限构建 Agent             |
| `atlas`\*      | subagent | —    | —            | 深度分析 Agent，只读         |
| `test-runner`† | subagent | —    | —            | 测试验证 Agent               |

\* 可选 Agent，需在配置中设置 `options.enabled: true`<br>
† 自定义 Agent（项目级 `.opencode/agent/test-runner.md`）

---

## 架构详解

### 生命周期（任务执行）

```
launch()
  │
  ├── 创建 SW-{uuid}
  ├── SharedBoard.init（创建 tasks/、artifacts/ 目录）
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

### 生命周期（讨论模式）

```
discuss()
  │
  ├── launch()（同任务执行）
  ├── Discussion.start(channel, [], max_rounds)
  │   └── 创建 discussion/{channel}.json（Round 1，expected 为空）
  │
  ▼ status: planning
  │
  Conductor 收到 goal（含讨论协议指令）
  ├── board_write create_task type="discuss"
  │
  ▼ status: running
  │
  ┌─── Round 1: 提案 ───────────────────────────────────────────┐
  │                                                              │
  │  Conductor 为每个角色调用 delegate_task：                     │
  │    role_name="PM", discussion_channel, run_in_background=true│
  │    → Discussion.join() 注册参与者                             │
  │                                                              │
  │  各 Worker 发布 proposal 信号                                 │
  │    → Discussion.record() 记录发言                             │
  │    → 检测 received.length >= expected.length                  │
  │    → complete = true                                          │
  │                                                              │
  │  Monitor 检测完成 → 转发给 Conductor：                        │
  │    "[Discussion Round 1 Complete — round 1/3]"               │
  │    + 各角色发言摘要                                           │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
  │
  ┌─── Round 2+: 回应 ──────────────────────────────────────────┐
  │                                                              │
  │  Conductor 调用 board_write advance_round                    │
  │    → Discussion.advance()（round++, received 清空）           │
  │                                                              │
  │  Conductor 再次 delegate_task，通过 session_id 复用 Worker   │
  │    → discussion-thread-injector 注入完整讨论线程              │
  │                                                              │
  │  各 Worker 阅读线程 → 发布 opinion / objection 信号           │
  │    → Discussion.record() → Monitor 检测完成                   │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
  │
  ┌─── 最终轮: 共识 ────────────────────────────────────────────┐
  │                                                              │
  │  各 Worker 发布 consensus 信号                                │
  │    payload: { position: "agree"|"disagree"|"modify" }        │
  │                                                              │
  │  Discussion.tally() 统计投票                                  │
  │  Monitor 将投票结果转发给 Conductor                           │
  │                                                              │
  │  全票同意 → 自动决策                                          │
  │  非全票   → Conductor 做最终裁决，记录异议                    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
  │
  Conductor 发布 decision artifact
  │
  ▼ status: completed
```

### Hook 系统

Swarm 注册了四个 hook：

**1. conductor-strategy-injector**

- 链：`pre-llm`，优先级 `150`
- 仅对 `conductor` agent 生效
- 从 board 目录加载 `conductor-strategy.md`，不存在则从模板复制
- 将策略内容追加到 system prompt
- 如果 board 中存在 `discuss` 类型任务，额外注入 `conductor-discussion.txt` 讨论协议

**2. discussion-thread-injector**

- 链：`pre-llm`，优先级 `160`
- 仅在 `OPENCODE_SWARM=1` 且会话元数据包含 `swarm_id` 和 `discussion_channel` 时生效
- 从 SharedBoard 加载该频道的完整信号列表
- 按轮次分组，格式化为 `## Discussion Thread` 注入 Worker 的 system prompt
- 确保每个 Worker 在回复前看到所有角色的历史发言

**3. scope-lock-checker**

- 链：`pre-tool`，优先级 `50`
- 仅在 `OPENCODE_SWARM=1` 时生效
- 在 `edit` / `write` 工具执行前检查 ScopeLock
- 如果文件被其他 Agent 锁定，抛出错误阻止操作

**4. checkpoint-publisher**

- 链：`post-tool`，优先级 `200`
- 仅在 `OPENCODE_SWARM=1` 且存在 swarm/task 上下文时生效
- 在 `bash`（typecheck 命令）或 `delegate_task` 成功后自动发布 checkpoint artifact

### delegate_task 与 Worker 创建

当 Conductor 调用 `delegate_task` 且参数包含 `swarm_id` 时：

1. **Agent 选择** — 强制使用 sisyphus agent
2. **Session 创建** — 独立 Primary Session（无 parentID），不继承 Conductor 上下文
3. **权限配置**：
   - `board_read` → allow
   - `board_write` → allow
   - `swarm_launch` → deny（防止嵌套 Swarm）
4. **注册** — Worker 信息记录到 `Swarm.workers[]`

讨论模式新增参数和行为：

| 参数                 | 说明                                          |
| -------------------- | --------------------------------------------- |
| `discussion_channel` | 讨论频道名称，用于定位 Round 状态             |
| `role_name`          | 角色名（如 PM、RD、QA），写入信号的 from 字段 |

当 `discussion_channel` 和 `role_name` 同时存在时，`delegate_task` 会自动调用 `Discussion.join()` 将角色注册为参与者。后续该 Worker 的讨论信号会被 `Discussion.record()` 追踪。

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

### Monitor 机制

Monitor 是 Swarm 的事件监听器，负责将关键信号转发给 Conductor。

**任务执行模式**中，Monitor 监听 `done`、`failed`、`blocked`、`conflict` 信号，附带看板统计信息一起转发给 Conductor。

**讨论模式**中，Monitor 额外监听 `proposal`、`opinion`、`objection`、`consensus` 四种讨论信号。处理流程：

1. 收到讨论信号 → 调用 `Discussion.record()` 记录发言
2. 检查 `roundState.complete`（所有预期参与者是否已发言）
3. 如果轮次完成，构造结构化消息发送给 Conductor：
   - 消息格式：`[Discussion Round N Complete — round N/M]`
   - 包含各角色本轮发言摘要
   - 如果是共识轮或最终轮，附加 `Discussion.tally()` 投票结果
   - 提示下一步操作：`advance_round` 或 `post decision artifact`
4. 如果轮次未完成，仅发送单条发言通知

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

**Playbook** 是可复用的策略模板，存储在 `board/playbooks/` 目录下。每个 Playbook 是带 frontmatter 的 Markdown 文件，包含 `name`、`trigger`、`version` 等元数据。Conductor 可以引用 Playbook 来处理特定场景。

### SSE 事件流

通过 `GET /swarm/:id/events` 订阅实时事件：

```
event: message
data: {"type": "task.updated", "payload": {...}, "timestamp": 1234567890}

event: message
data: {"type": "signal", "payload": {...}, "timestamp": 1234567891}

event: message
data: {"type": "swarm.completed", "payload": {...}, "timestamp": 1234567900}
```

| 事件类型           | 触发条件                 |
| ------------------ | ------------------------ |
| `task.updated`     | 任务状态变更             |
| `artifact.created` | 新产物发布               |
| `signal`           | 新信号发送（含讨论信号） |
| `swarm.updated`    | Swarm 状态变更           |
| `swarm.completed`  | Swarm 完成（连接关闭）   |
| `swarm.failed`     | Swarm 失败（连接关闭）   |

---

## 最佳实践

### 通用

- 目标要具体、可衡量，让 Conductor 能明确拆解
- 对不熟悉的代码库，从 `max_workers: 2` 开始，逐步增加并发
- 用 `intervene` 随时修正方向
- 复杂 Swarm 推荐使用 Web Dashboard 实时监控

### 任务执行

- 选择可以拆解为 3 个以上 **并行** 子任务的工作
- 在目标描述中显式声明模块边界，帮助 Conductor 规划 scope
- **并行任务不要修改同一个文件** — 这是最重要的原则
- 如果两个任务确实需要改同一个文件，让 Conductor 先创建一个"接口定义"任务，完成后再并行后续任务
- 启用 `verify_on_complete` 确保最终代码质量

### 讨论

- **选择合适的话题**：适合有争议或需要多角度分析的决策，不适合有明确正确答案的问题
- **设计好角色**：角色名简短（PM、RD、QA、DevOps、Security）；perspective 要具体，引导不同视角
- **轮次设置**：简单议题 2 轮，复杂议题 3-4 轮；`max_rounds` 默认 3
- **干预讨论**：通过 `intervene` 引导 Conductor，比如"要求所有角色重点讨论性能影响"
- **自定义角色示例**：Security Architect、Performance Engineer、UX Designer

### 场景选择

| 场景                         | 推荐模式 |
| ---------------------------- | -------- |
| 修一个 bug                   | 单 Agent |
| 给函数加类型                 | 单 Agent |
| 多模块重构                   | 任务执行 |
| 新功能（前端 + 后端 + 测试） | 任务执行 |
| 批量迁移 API                 | 任务执行 |
| 技术选型（GraphQL vs REST）  | 讨论     |
| API 设计评审                 | 讨论     |
| 架构决策（微服务 vs 单体）   | 讨论     |
| 安全方案评估                 | 讨论     |

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

### 讨论轮次不推进

**原因**：Monitor 尚未检测到轮次完成，即并非所有预期参与者都已发言。

**检查**：

```bash
# 查看讨论状态，确认谁尚未发言
curl http://localhost:4096/swarm/SW-xxx/discussion

# 或用 board_read
board_read({
  operation: "discussion",
  swarm_id: "SW-xxx",
  filter: { channel: "discuss-a1b2c3d4" }
})
```

如果某个 Worker 卡住，可以通过 `intervene` 提示 Conductor 催促或跳过该角色。

### 讨论无法达成共识

**这是预期行为。** 当投票不是全票同意时，Conductor 会做最终裁决，并在 decision artifact 中记录各方立场和不同意见。你可以通过 `intervene` 要求 Conductor 额外增加一轮讨论来缩小分歧。

---

## API 参考

### Tool Schema

#### swarm_launch

```ts
{
  goal: string
  max_workers?: number
}
```

返回 `Swarm.Info` 对象。

#### swarm_discuss

```ts
{
  topic: string
  roles: Array<{
    name: string          // 角色名，如 "PM", "RD", "QA"
    perspective: string   // 角色视角描述
  }>
  max_rounds?: number     // 默认 3
}
```

返回 `Swarm.Info` 对象。

#### swarm_status

```ts
{
  id: string
}
```

#### swarm_intervene

```ts
{
  id: string
  message: string
}
```

#### swarm_stop

```ts
{
  id: string
}
```

#### swarm_list

无参数。返回所有 Swarm 列表。

#### board_read

```ts
{
  operation: "tasks" | "artifacts" | "signals" | "snapshot" | "discussion"
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

当 `operation` 为 `"discussion"` 时，`filter.channel` 必填。返回 `{ round, thread }` 对象。

#### board_write

```ts
{
  operation: "create_task" | "update_task" | "post_artifact" | "signal" | "advance_round"
  swarm_id: string
  data: Record<string, unknown>
}
```

`create_task` 的 data：

```ts
{
  subject: string
  description?: string
  type: "implement" | "review" | "test" | "investigate" | "fix" | "refactor" | "discuss"
  scope?: string[]
  blockedBy?: string[]
  blocks?: string[]
  assignee?: string
}
```

`update_task` 的 data：

```ts
{
  id: string
  status?: string
  assignee?: string
  scope?: string[]
}
```

`post_artifact` 的 data：

```ts
{
  type: "analysis" | "code_change" | "test_result" | "decision" | "finding" | "checkpoint" | "proposal" | "review_comment" | "summary"
  task_id: string
  author: string
  content: string
  files?: string[]
  supersedes?: string
}
```

`signal` 的 data：

```ts
{
  channel?: string     // 默认 "general"
  type: "progress" | "conflict" | "question" | "done" | "blocked" | "need_review" | "failed" | "proposal" | "opinion" | "objection" | "consensus"
  from: string
  payload: Record<string, unknown>
}
```

`advance_round` 的 data：

```ts
{
  channel: string // 讨论频道名称（必填）
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

| 方法   | 路径                    | 说明               |
| ------ | ----------------------- | ------------------ |
| `POST` | `/swarm`                | 启动任务执行 Swarm |
| `POST` | `/swarm/discuss`        | 启动讨论 Swarm     |
| `GET`  | `/swarm`                | 列出所有 Swarm     |
| `GET`  | `/swarm/:id`            | 获取 Swarm 状态    |
| `GET`  | `/swarm/:id/discussion` | 获取讨论状态       |
| `POST` | `/swarm/:id/intervene`  | 发消息给 Conductor |
| `POST` | `/swarm/:id/pause`      | 暂停 Swarm         |
| `POST` | `/swarm/:id/resume`     | 恢复 Swarm         |
| `POST` | `/swarm/:id/stop`       | 停止 Swarm         |
| `GET`  | `/swarm/:id/events`     | SSE 事件流         |

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

### 数据结构

#### Swarm.Info

```ts
{
  id: string                     // SW-{uuid}
  goal: string                   // 用户目标（讨论模式中为格式化的讨论指令）
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

#### Discussion.Round

```ts
{
  round: number                  // 当前轮次
  max_rounds: number             // 最大轮次
  channel: string                // 频道名称
  swarm_id: string               // 所属 Swarm ID
  expected: string[]             // 预期参与者（角色名）
  received: string[]             // 已发言参与者
  complete: boolean              // 当前轮次是否完成
}
```

#### Discussion.Tally

```ts
{
  agree: number // 同意人数
  disagree: number // 反对人数
  modify: number // 建议修改人数
  total: number // 总投票数
  unanimous: boolean // 是否全票同意
  positions: Array<{
    from: string // 角色名
    position: string // agree / disagree / modify
    summary: string // 立场摘要
  }>
}
```
