# PRD: Token 消耗全面优化

## Introduction

基于对 opencode 源码和 log-viewer 数据的深度分析，发现 token 消耗存在多个可优化点。本 PRD 旨在**消除不必要的 token 浪费**，在保持功能完整性的前提下，将总 token 消耗降低 30%-50%。

### 核心设计原则

1. **Prune 免费，Compaction 昂贵** — prune 只截断已存储的数据（零 LLM 成本），compaction 本身是一次完整 LLM 调用（80K-180K 输入）。优化策略应**最大化 prune 效果以延迟甚至避免 compaction**。
2. **前缀稳定 = 缓存命中** — Anthropic prompt caching 是前缀匹配：system prompt 的前 N 个 token 不变就能命中缓存。AGENTS.md 保持全量注入但位置固定，通过缓存折扣（1/10 价格）降低实际费用，比"按需加载"更可靠。
3. **智能裁剪优于一刀切** — prune 不应按位置裁剪，应结合 LLM 标记的重要性 + 启发式推断 + 用户自定义 hooks。
4. **不替用户做决定，但让用户知道** — 不硬编码模型选择，当检测到浪费时主动提示用户配置优化。
5. **可观测先行** — 先有诊断能力，再做优化，确保每步可量化验证。

## Goals

- 减少单次 LLM 请求的平均 input token 消耗 30%+
- 提高 Anthropic prompt cache 命中率至 50%+
- 减少 Memory 系统产生的额外 LLM 调用次数 50%+
- 工具定义注入从全量改为按需，减少 40%+ 工具 token
- 增强 log-viewer 的 token 诊断能力
- 当 Memory / Category 子系统未配置专用模型时，主动提示用户配置

## 消耗分析摘要

| 排名 | 消耗源          | 单次估算      | 增长趋势            | 核心问题                                         |
| ---- | --------------- | ------------- | ------------------- | ------------------------------------------------ |
| 1    | 消息历史        | 5K-100K+      | 随对话线性增长      | prune 按位置一刀切，重要输出被裁、垃圾输出被留   |
| 2    | 系统提示词      | 3K-15K        | 每次固定            | 不同 agent 未分级；依赖 cache 可大幅降低实际费用 |
| 3    | 工具定义注入    | 4K-18K        | 与 MCP 工具数成正比 | 全量注册，denied 工具仍生成 schema               |
| 4    | Memory LLM 调用 | 2K-60K/次     | 周期触发            | 频率过高；用主模型跑 memory 浪费                 |
| 5    | 压缩            | 80K-180K 输入 | 溢出时触发          | 压缩本身是单次最大 token 消耗，应尽量延迟        |
| 6    | 子任务/委托     | 5K-50K/次     | 每次 Task 调用      | category 未绑定模型，全部用主模型                |

## User Stories

---

### US-001: 基于重要性的智能 Prune

**Description:** As a developer, I want prune to remove unimportant tool outputs while preserving critical ones so that token usage is reduced without losing context that the LLM needs.

**背景：** 当前 prune（`compaction.ts:59-100`）按位置裁剪——保留最近 40K tokens 的工具输出，之前的全部裁掉。问题在于：3 步前读取的关键配置文件被裁掉了，而 1 步前的巨大 build log（几千行）反而被保留。

prune 是零 LLM 成本的操作（只标记 `part.state.time.compacted = Date.now()`，不调用 LLM）。但当前 prune **只在 agent 停止后执行**（`prompt.ts:793`），而 compaction 在每个 step 后检查 `isOverflow()`。这意味着一轮长对话中工具输出不断累积，prune 从未执行，直到 token 超限直接触发昂贵的 compaction。

**新策略：三层智能裁剪**

```
第一层：LLM 标记（主）
  - tool part 新增 retain 字段：true | false | undefined
  - LLM 在工具调用返回后，可对 tool result 标记 retain
  - retain: false → prune 优先裁剪
  - retain: true  → prune 跳过

第二层：启发式推断（fallback）
  - retain === undefined（LLM 未标记）时：
  - 检查后续 assistant 回复是否引用了该工具输出的关键内容（文件名、变量名等）
  - 按工具类型给默认权重：
    - read → 较重要（可能是关键文件）
    - grep/glob → 中等（搜索结果，通常可重新执行）
    - bash → 较不重要（build log、test output 通常很大且一次性）

第三层：用户自定义 hooks
  - 注册 "prune" hook，在 prune 执行时对每个候选 part 调用
  - hook 可以：修改 retain 标记、自定义裁剪（只保留前 N 行）、按正则过滤
  - 即使 retain: true 的输出，hook 也可以选择缩减内容
```

**执行时机调整：**

- 从"agent 停止后执行一次"改为"每个 step 的 `isOverflow()` 检查之前先执行 prune"
- 这样 prune 先免费清理，可能就不触发 compaction 了

**Acceptance Criteria:**

- [ ] `MessageV2.ToolPart` 新增可选字段 `retain: boolean | undefined`
- [ ] LLM tool response 处理流程中，支持从 response metadata 中读取 retain 标记并写入 part
- [ ] 当 `retain === undefined` 时，启发式推断模块根据工具类型 + 后续引用情况推断重要性
- [ ] 启发式推断的工具权重可通过 `config.compaction.tool_weights` 配置（如 `{ read: 0.8, bash: 0.2 }`）
- [ ] 新增 `HookChain` 的 `"prune"` 链，在 prune 执行时对每个候选 part 调用，hook 可修改 retain 或自定义裁剪输出内容
- [ ] prune 执行时机从 `prompt.ts:793`（agent 停止后）移到 `processor.ts:283-288`（每个 step 的 isOverflow 检查之前）
- [ ] 原有的 `PRUNE_PROTECT` 和 `PRUNE_MINIMUM` 阈值仍作为兜底：即使没有 retain 标记，也按现有位置逻辑保护最近的输出
- [ ] prune 日志记录：`log.info("pruned", { count, retained, heuristic, hooked, saved_tokens })`
- [ ] Typecheck passes

---

### US-002: 压缩触发阈值可配置

**Description:** As a developer, I want to tune when compaction triggers so that I can balance context richness vs the high cost of compaction itself.

**背景：** `isOverflow()` 在 `compaction.ts:33-49` 判断是否需要压缩。当前逻辑：`totalTokens >= model.limit.input - reserved`（reserved 默认 20,000）。200K context 的模型在 ~180K 时才触发。配合 US-001 的 prune 前置，compaction 触发频率会自然降低，但仍需要提供配置入口。

**Acceptance Criteria:**

- [ ] `COMPACTION_BUFFER` 改为从 `config.compaction.buffer` 读取（默认保持 20,000）
- [ ] 新增 `config.compaction.trigger_ratio`（0.0-1.0，可选），表示 context 使用率达到多少时触发——例如 0.7 表示 200K 模型在 140K 时压缩
- [ ] `trigger_ratio` 与 `buffer` 互斥，同时设置时配置校验报错
- [ ] Typecheck passes

---

### US-003: 按 Agent 类型分级系统提示词

**Description:** As a developer, I want different agent types to receive appropriately sized system prompts so that lite agents don't pay for irrelevant content.

**背景：** 当前 `prompt.ts:720-722` 已实现 `agent.lite` 跳过环境信息和 AGENTS.md。`memory-extractor` 和 `memory-recall` 已设置 `lite: true`。AGENTS.md 保持全量注入（依赖 prompt caching 降低费用），但不同 agent 对 AGENTS.md 的需求不同。

**三级策略：**

| 级别       | 注入内容                                                           | 适用 Agent                                                  | 估算 token |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------------- | ---------- |
| **full**   | provider prompt + env + AGENTS.md + memory                         | sisyphus, build, plan                                       | 5K-15K     |
| **medium** | provider prompt + env + memory（无 AGENTS.md）                     | explore, oracle, general, omo-explore                       | 3K-8K      |
| **lite**   | 仅 agent.prompt + 调用方 system（无 env、无 AGENTS.md、无 memory） | memory-extractor, memory-recall, title, summary, compaction | 0.5K-2K    |

> **注意：** Memory 在 `full` 和 `medium` 都注入——subagent 也可能需要用户偏好（如"本项目用 Hono 不用 Express"）。仅 `lite`（memory 自身的 agent）不注入 memory，避免循环依赖。
>
> AGENTS.md 在 `medium` 不注入。理论上可以让主 agent 判断任务是否需要来告诉 subagent 是否加载 AGENTS.md，但依赖 prompt caching 后 AGENTS.md 的实际费用已经很低。`medium` 省略 AGENTS.md 是低优先级优化——如果 cache hit rate 数据显示 subagent 缓存命中率也很高，可以进一步简化为只保留 `full` 和 `lite` 两级。

**Acceptance Criteria:**

- [ ] `Agent.Info` 中 `lite: boolean` 改为 `prompt_level: "full" | "medium" | "lite"`（向后兼容：`lite: true` 等价于 `prompt_level: "lite"`）
- [ ] `prompt.ts` 中根据 `prompt_level` 构建 system prompt：
  - `full`：provider prompt + environment + InstructionPrompt.system() + memory（via hook）
  - `medium`：provider prompt + environment + memory（跳过 InstructionPrompt.system()）
  - `lite`：空数组（当前行为不变）
- [ ] 默认 `prompt_level`：`mode === "primary"` → `"full"`；`mode === "subagent"` → `"medium"`；原 `lite: true` → `"lite"`
- [ ] `compaction` agent 设为 `"lite"`
- [ ] 用户可通过 `config.agent.<name>.prompt_level` 覆盖
- [ ] Typecheck passes

---

### US-004: 稳定系统提示词前缀以提高缓存命中率

**Description:** As a developer, I want the system prompt prefix to be stable across calls so that Anthropic's prefix-based prompt caching maximizes cache hits.

**背景：** Anthropic prompt caching 是前缀匹配。当前拼接顺序大致为 `provider prompt → env → AGENTS.md → memory`。Memory 在末尾，变化不影响前缀。但 `SystemPrompt.environment()` 中 model name 在开头（`"You are powered by the model named ..."`），不同模型会破坏前缀。

**Acceptance Criteria:**

- [ ] `SystemPrompt.environment()` 中 model 信息移至 `<env>` 块末尾（稳定内容在前：工作目录、平台、日期）
- [ ] `memory/hooks/inject.ts` 的 hook 注册处添加注释，说明 priority 130 保证 memory 在最后、对缓存命中率的重要性
- [ ] `capture.ts` pre-llm hook 新增 `prompt_prefix_hash`（取 system prompt 前 2000 字符的 `Bun.hash()`）
- [ ] log-viewer analyze API 新增检测：同一 session 内 `prompt_prefix_hash` 变化频率 > 50% 时建议 "system prompt prefix is unstable"
- [ ] Typecheck passes

---

### US-005: 按 Agent 裁剪工具定义

**Description:** As a developer, I want each agent to only inject the tools it actually needs so that tool definitions don't consume unnecessary tokens.

**背景：** `resolveTools()` 在 `prompt.ts:818-1118` 中注册所有工具。当 agent 已通过 permission deny 某工具时，该工具仍被注册（占用 schema token），只是在执行时被拦截。`explore` agent 明确 deny 了大部分工具但仍注册了全量 schema。

**Acceptance Criteria:**

- [ ] `resolveTools()` 在注册工具前，检查 agent 的 permission 规则：工具被明确 deny 且无 "ask" 条件时，跳过注册（不生成 schema）
- [ ] 新增 `Agent.Info.tools_include` 可选白名单（`string[]`），设置后只注册白名单中的工具
- [ ] MCP 工具支持 server 粒度通配：`"lark-mcp/*"` 表示该 server 的所有工具
- [ ] 未设置 `tools_include` 且未 deny 任何工具时行为不变
- [ ] log-viewer detail API 新增 `tool_count` 字段
- [ ] Typecheck passes

---

### US-006: Memory 提取降频与智能跳过

**Description:** As a developer, I want memory extraction to be less frequent and smarter about when to skip so that background LLM calls are reduced.

**Acceptance Criteria:**

- [ ] `DEFAULT_INTERVAL` 改为从 `config.memory.extract_interval` 读取（默认 20，原 10）
- [ ] `MIN_MESSAGES` 改为从 `config.memory.extract_min_messages` 读取（默认 6，原 4）
- [ ] 新增智能跳过：自上次提取以来的消息中，用户文本消息数 < 2 时跳过本轮
- [ ] `recoveryExtract()` 限制为最近 N 天（`config.memory.recovery_max_age_days`，默认 7）
- [ ] `recoveryExtract()` 分批处理：每批最多 5 个 session，处理完一批再取下一批，避免启动时大量并发 LLM 调用
- [ ] 跳过时记录：`log.info("extraction skipped", { reason, sessionID, userMsgCount })`
- [ ] Typecheck passes

---

### US-007: Memory / Category 使用主模型时提示用户

**Description:** As a developer, I want the system to warn me when memory agents or task categories are using my expensive primary model so that I can configure cheaper alternatives.

**背景：** `extractor.ts:model()` 和 `recall.ts:model()` 的 fallback 链为 `agent config → config.memory → Provider.defaultModel()`。`Categories.DEFAULTS` 8 个 category 全部没设 `model` 字段，`category` 参数形同虚设——所有子任务 fallback 到父会话的主模型。不硬编码默认模型，但应主动提示用户。

**Acceptance Criteria:**

- [ ] Memory agent：当实际使用模型等于 `Provider.defaultModel()` 时，首次调用发出 `log.warn("memory-extractor using primary model, consider config.agent.memory-extractor.model")`
- [ ] Category：当 `category` 指定但该 category 未配置 `model` 时，首次触发发出 `log.warn("category 'quick' has no model configured, using primary model. Configure via config.categories.quick.model")`
- [ ] 两类警告均通过 `Bus.publish()` 发布事件，TUI 可接收并展示
- [ ] 每个 session 每种警告最多显示一次（避免刷屏）
- [ ] log-viewer analyze API 新增 `memory_model_cost` 建议：memory agent 使用高价模型（cost.input > $3/MTok）时建议切换
- [ ] log-viewer analyze API 新增 `category_no_model` 建议：使用了 category 但无专用模型时建议配置
- [ ] Typecheck passes

---

### US-008: 压缩 LLM 输入瘦身

**Description:** As a developer, I want the compaction LLM to receive a leaner input so that compaction itself consumes fewer tokens, without degrading summary quality.

**背景：** Compaction（`compaction.ts:102-304`）将全部消息历史发给 LLM 生成 summary。历史中包含冗余：

- `synthetic: true` 的文本（如 `"Called the Read tool with..."`）——UI 展示用，LLM 不需要
- 已 prune 的工具输出（`toModelMessages` 输出 `[output compacted]` 占位符仍占 token）

Compaction 当前已使用 `system: []` 且 agent 为 `lite` 级别（US-003），不注入 AGENTS.md/memory/env。此 story 只优化消息内容。

**Acceptance Criteria:**

- [ ] `MessageV2.toModelMessages()` 新增 `stripSynthetic` 选项（默认 false）：true 时跳过 `part.synthetic === true` 的文本
- [ ] `compaction.ts:process()` 调用时传入 `{ stripMedia: true, stripSynthetic: true }`
- [ ] 已 prune 的工具输出在 compaction 时，只保留工具名 + 输入参数摘要（≤200 字符），不保留 `[output compacted]`
- [ ] log-viewer 中 compaction 请求自动记录 annotation：`{ type: "compaction_stats", content: "before: {N} tokens, stripped_synthetic: {S}" }`
- [ ] Typecheck passes

---

### US-009: Log-viewer Token 诊断增强

**Description:** As a developer, I want the log-viewer to provide richer token diagnostics so that I can identify and fix token waste without reading source code.

**Acceptance Criteria:**

- [ ] list API 返回字段新增 `cache_read_tokens` 和 `cache_write_tokens`（当前只返回 `input_tokens` 和 `output_tokens`）
- [ ] detail API 新增计算字段：`system_prompt_tokens`（解压后字节数 / 4）、`tool_count`（工具数量）、`message_count`（消息条数）
- [ ] stats API 新增 `total_tokens` 聚合（= input + output + cache_read + cache_write + reasoning）
- [ ] analyze API 新增建议类型 `memory_model_cost`：memory agent 使用高价模型时建议切换
- [ ] analyze API 新增建议类型 `category_no_model`：使用了 category 但无专用模型时建议配置
- [ ] analyze API 新增建议类型 `tool_count_high`：平均工具数 > 30 时建议裁剪
- [ ] analyze API 新增建议类型 `prompt_prefix_unstable`：同 session 内 prompt_prefix_hash 变化频率 > 50% 时告警
- [ ] Typecheck passes

---

### US-010: 缓存命中率可观测性 + TUI 展示

**Description:** As a developer, I want to see cache hit rates in the TUI and log-viewer so that I can verify optimization effectiveness in real time.

**Acceptance Criteria:**

- [ ] stats API `group_by=session` 时返回每个 session 的 `cache_hit_rate`（= cache_read / (input + cache_read + cache_write)）
- [ ] analyze API 返回 per-model 缓存命中率
- [ ] TUI 的 Context 指示器下方新增 cache hit rate 显示（如 `Cache: 67%`），基于当前 session 的累计数据
- [ ] cache hit rate 数据来源：累计当前 session 所有 step 的 `cache_read_tokens / (input_tokens + cache_read_tokens + cache_write_tokens)`
- [ ] 当 session 无 cache 数据时（非 Anthropic provider 或首次调用），不显示此指标
- [ ] Typecheck passes

---

## Functional Requirements

**智能 Prune（US-001）**

- FR-1: `MessageV2.ToolPart` 新增 `retain: boolean | undefined` 字段
- FR-2: LLM tool response 处理支持读取 retain 标记
- FR-3: 启发式推断模块：按工具类型 + 后续引用推断重要性
- FR-4: `config.compaction.tool_weights` 配置工具类型的默认重要性权重
- FR-5: `HookChain` 新增 `"prune"` 链，支持用户自定义裁剪逻辑
- FR-6: prune 执行时机移到每个 step 的 isOverflow 检查之前
- FR-7: 原有 `PRUNE_PROTECT`/`PRUNE_MINIMUM` 作为兜底阈值

**压缩配置（US-002）**

- FR-8: `config.compaction.buffer`（number，默认 20000）
- FR-9: `config.compaction.trigger_ratio`（0.0-1.0，可选）；与 buffer 互斥

**系统提示词分级（US-003）**

- FR-10: `Agent.Info.prompt_level`（`"full"` | `"medium"` | `"lite"`）
- FR-11: `medium` 级别注入 provider prompt + env + memory，不注入 AGENTS.md
- FR-12: `lite` 级别注入空数组（当前行为）
- FR-13: 用户可通过 `config.agent.<name>.prompt_level` 覆盖

**缓存稳定性（US-004）**

- FR-14: `SystemPrompt.environment()` model 信息后移
- FR-15: `capture.ts` 记录 `prompt_prefix_hash`

**工具裁剪（US-005）**

- FR-16: `resolveTools()` 跳过被 deny 工具的 schema 注册
- FR-17: `Agent.Info.tools_include` 白名单，MCP 支持 `server/*` 通配

**Memory 优化（US-006）**

- FR-18: `config.memory.extract_interval` 默认 20
- FR-19: `config.memory.extract_min_messages` 默认 6
- FR-20: 智能跳过：用户文本消息 < 2 时不提取
- FR-21: `config.memory.recovery_max_age_days` 默认 7；分批处理，每批 5 个 session

**模型提示（US-007）**

- FR-22: Memory agent 使用主模型时首次警告 + Bus 事件
- FR-23: Category 无专用模型时首次警告 + Bus 事件
- FR-24: 每 session 每种警告最多一次

**压缩瘦身（US-008）**

- FR-25: `toModelMessages()` 支持 `stripSynthetic` 选项
- FR-26: Compaction 调用时启用 `stripSynthetic: true`

**Log-viewer（US-009）**

- FR-27: list API 增加 cache_read_tokens、cache_write_tokens
- FR-28: detail API 增加 system_prompt_tokens、tool_count、message_count
- FR-29: stats API 增加 total_tokens
- FR-30: analyze API 增加 memory_model_cost、category_no_model、tool_count_high、prompt_prefix_unstable 建议类型

**TUI 可观测（US-010）**

- FR-31: TUI Context 下方展示 session cache hit rate
- FR-32: 非 Anthropic provider 或无数据时隐藏

## Non-Goals

- **不自建 tokenizer** — token 计数依赖 AI SDK 返回值
- **不实现消息增量发送** — 仍发送完整历史，优化限于 prune/compact/strip
- **不修改 Anthropic prompt caching API** — caching 由 provider SDK 自动处理
- **不修改 AGENTS.md 注入方式** — 保持全量注入，依赖 prompt caching 降低费用
- **不限制用户对话长度** — 只裁剪和压缩，不强制中断
- **不修改 compaction summary 格式** — Goal/Instructions/Discoveries/Accomplished/Files 不变
- **不实现 token 预算硬限制** — 不设 "单次不超过 X token" 上限
- **不硬编码模型选择** — 不替用户做决定，只提示

## Design Considerations

- 所有新增配置项均为可选，不设置时行为与优化前一致（100% 向后兼容）
- `prompt_level` 对现有 `lite: true` 向后兼容
- `retain` 标记对不支持该功能的旧模型透明——未标记时 fallback 到启发式 + 位置裁剪
- log-viewer 新增字段为追加式，不删除现有字段
- TUI cache hit rate 使用已有的 token 统计数据，不引入额外 LLM 调用

## Technical Considerations

### 关键文件清单

| 文件                             | 涉及 Story             | 修改内容                                      |
| -------------------------------- | ---------------------- | --------------------------------------------- |
| `session/compaction.ts`          | US-001, US-002, US-008 | 智能 prune + 触发配置 + stripSynthetic        |
| `session/prompt.ts`              | US-001, US-003, US-005 | prune 时机 + prompt_level + resolveTools 过滤 |
| `session/processor.ts`           | US-001                 | prune 前置于 isOverflow 检查                  |
| `session/system.ts`              | US-004                 | model info 后移                               |
| `session/message-v2.ts`          | US-001, US-008         | retain 字段 + stripSynthetic                  |
| `agent/agent.ts`                 | US-003, US-005         | prompt_level + tools_include                  |
| `agent/background/categories.ts` | US-007                 | 无代码改动，通过 log-viewer 提示              |
| `memory/hooks/auto-extract.ts`   | US-006                 | 频率 + 跳过 + recovery 分批                   |
| `memory/engine/extractor.ts`     | US-006, US-007         | 配置读取 + 主模型警告                         |
| `memory/engine/recall.ts`        | US-007                 | 主模型警告                                    |
| `memory/hooks/inject.ts`         | US-003, US-004         | medium 注入 memory + 顺序注释                 |
| `log/capture.ts`                 | US-004, US-008         | prompt_prefix_hash + compaction annotation    |
| `log/query.ts`                   | US-009, US-010         | 新增字段和建议类型                            |
| `config/config.ts`               | 多个                   | 新增配置项类型定义                            |
| TUI Context 组件                 | US-010                 | cache hit rate 展示                           |

### 实施依赖与推荐顺序

```
Phase 1 — 可观测性（先有度量）
  US-009 (log-viewer 诊断增强)
  US-010 (缓存命中率 + TUI)
  US-004 (prompt_prefix_hash)

Phase 2 — 低风险高收益
  US-001 (智能 prune — 零 LLM 成本)      ← 最大收益
  US-005 (工具裁剪 — 利用现有 permission)
  US-006 (memory 降频)

Phase 3 — 中等风险
  US-003 (prompt_level 分级)
  US-007 (Memory/Category 模型提示)
  US-008 (压缩输入瘦身)

Phase 4 — 需验证效果
  US-002 (压缩触发比例)
```

### 性能约束

- 所有 log-viewer 查询在 SQLite 中完成，不引入额外存储
- `prompt_prefix_hash` 使用 `Bun.hash()`
- 启发式推断（工具输出引用检查）在 prune 时同步执行，需确保 O(N) 时间复杂度
- prune hook 调用需设置超时（如 100ms/part），避免自定义 hook 阻塞主流程

## Success Metrics

| 指标                    | 度量方式                                                  | 目标                   |
| ----------------------- | --------------------------------------------------------- | ---------------------- |
| 平均 input tokens       | `GET /api/logs/stats` → `avg_input_tokens`                | 下降 30%+              |
| Cache hit rate          | TUI Context 展示 / `GET /api/logs/analyze`                | 提升至 50%+            |
| Memory LLM 调用次数     | `GET /api/logs/stats?agent=memory-extractor`              | 减少 50%+              |
| 平均工具数              | detail API → `tool_count`                                 | denied agent 下降 40%+ |
| Compaction 触发频率     | `GET /api/logs/stats?agent=compaction` 的 request_count   | 减少 40%+              |
| Compaction input tokens | `GET /api/logs/stats?agent=compaction` → avg_input_tokens | 下降 20%+              |

## Open Questions

1. **retain 标记的 schema 设计** — 如何在现有 tool response 格式中优雅地传递 retain 标记？是扩展 tool_call metadata，还是新增一个特殊的 system 指令让 LLM 在回复中标记？需要评估不同模型的兼容性。
2. **启发式推断的准确度** — "后续回复是否引用了工具输出"的检测需要做字符串匹配，可能有误判。需要定义匹配规则和阈值。
3. **prune hook 的 API 设计** — hook 的输入输出格式需要定义。是传完整 part 还是只传 output？hook 是否可以修改 output 内容（部分裁剪）还是只能 retain/prune 二选一？
4. **TUI cache hit rate 更新频率** — 每个 step 后实时更新，还是每轮对话结束后更新？实时更新更直观但可能闪烁。
5. **prompt_level: "medium" 的长期必要性** — 如果 cache hit rate 数据显示 subagent 的缓存命中率也很高（AGENTS.md 成本被缓存抵消），是否可以简化为只保留 full/lite 两级？
