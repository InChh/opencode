# PRD: Memory Prompt 外置化

## Introduction

当前 Memory 系统中有 5 处 prompt 内容硬编码在源代码中，用户无法通过配置自定义或覆盖。opencode 已为 Agent、Command 等子系统建立了成熟的 `.opencode/` 目录约定来支持用户自定义 prompt，但 Memory 系统未对齐这一设计。

本 PRD 定义了将 Memory 系统所有内置 prompt 外置到 `.opencode/memory/` 目录的改造方案，同时将 `/remember`、`/forget` 命令收归为 `/memory` 的子命令，统一 Memory 系统的用户交互入口。

## Key Architectural Decisions

### AD-1: 方案 B — `.opencode/memory/` 目录约定

采用 `.opencode/memory/` 目录约定（方案 B），**不**扩展 `config.memory` schema 增加 prompt 字段。原因：保持 config schema 简洁，与现有 Agent/Command 的目录约定对齐。

### AD-2: 固定文件名映射

`.opencode/memory/` 下采用固定文件名与功能一对一映射，不使用 frontmatter type 字段识别。文件名即语义：

```
.opencode/memory/
  recall.md           → P1: Recall Agent 系统提示词
  extract.md          → P4+P5: Auto-Extract 系统提示词 + 分析提示词
  inject.md           → P6: Memory 注入格式模板
  optimizer.md        → P7: Optimizer 优化策略
```

### AD-3: HTML 注释标记的模板变量注入

对于包含动态内容的 prompt（P5 的会话消息、P6 的 memory 列表），使用 HTML 注释标记 `<!-- INJECT:VAR_NAME -->` 作为注入点。系统在运行时将标记替换为实际内容。

用户自定义文件中需包含教学注释说明可用变量。内置默认文件作为示例和文档。

### AD-4: /memory 统一命令入口

将 `/remember` 和 `/forget` 从独立顶层命令收归为 `/memory` 的子命令：

- `/memory:remember <text>` — 保存记忆
- `/memory:forget <id|search>` — 删除记忆
- `/memory:list` — 列出所有记忆

保留 `/remember` 和 `/forget` 作为向后兼容别名。

### AD-5: Prompt 加载优先级

遵循 opencode 现有的目录查找链（按 `ConfigPaths.directories()` 返回顺序），后发现的文件覆盖先发现的。最终优先级：

```
内置默认值（最低）
  ↑ ~/.config/opencode/memory/*.md（全局用户级）
  ↑ .opencode/memory/*.md（项目级，最高）
```

未提供自定义文件时，fallback 到代码内置的默认值。

### AD-6: 测试策略 — 单元 + 集成混合

- **单元测试**：覆盖 prompt 加载逻辑、模板变量替换、文件名映射、优先级合并
- **集成测试**：覆盖端到端的覆盖/回退链路，使用临时目录模拟 `.opencode/memory/` 结构

## Goals

- 将 Memory 系统 5 处内置 prompt 全部外置为可覆盖的 `.opencode/memory/*.md` 文件
- 统一 `/remember`、`/forget`、`/memory list` 为 `/memory` 子命令体系
- 建立 HTML 注释标记的模板变量注入机制
- 保证向后兼容：无自定义文件时行为与现状完全一致
- 提供全面的单元测试和集成测试覆盖

## User Stories

### US-001: 创建 Memory Prompt 加载器

**Description:** 作为开发者，我需要一个 prompt 加载器模块，它能按优先级从 `.opencode/memory/` 目录链中加载 prompt 文件，未找到时 fallback 到内置默认值。

**Acceptance Criteria:**

- [ ] 新建 `memory/prompt/loader.ts` 模块，导出 `load(name: string): Promise<string>` 函数
- [ ] `name` 参数接受固定值：`"recall"` | `"extract"` | `"inject"` | `"optimizer"`
- [ ] 按 `ConfigPaths.directories()` 返回的目录列表，从后往前扫描 `memory/{name}.md`，取最后匹配
- [ ] 找到用户文件时返回其内容（去除 frontmatter，仅保留 body）
- [ ] 未找到任何用户文件时返回内置默认值（从 `memory/prompt/default/*.txt` 加载）
- [ ] 支持 frontmatter 中的 `description` 字段（可选，用于自文档化，不影响加载行为）
- [ ] Typecheck 通过

### US-002: 实现 HTML 注释标记的模板变量替换

**Description:** 作为开发者，我需要一个模板引擎，能识别 prompt 文件中的 `<!-- INJECT:VAR_NAME -->` 标记并替换为实际内容。

**Acceptance Criteria:**

- [ ] 新建 `memory/prompt/template.ts` 模块，导出 `render(template: string, vars: Record<string, string>): string` 函数
- [ ] 识别 `<!-- INJECT:VAR_NAME -->` 格式标记（大小写不敏感，允许空格：`<!-- INJECT: VAR_NAME -->`）
- [ ] 匹配到的标记替换为 `vars[VAR_NAME]` 的值
- [ ] 未匹配的标记保留原文（不报错，不删除）
- [ ] 支持一个模板中存在多个不同标记
- [ ] 支持同一标记出现多次
- [ ] Typecheck 通过

### US-003: 外置 Recall Agent 系统提示词（P1）

**Description:** 作为用户，我希望通过 `.opencode/memory/recall.md` 自定义 Recall Agent 的行为策略，使其更符合我的项目需求。

**Acceptance Criteria:**

- [ ] 将现有 `memory/agent/recall.txt` 内容迁移为内置默认值 `memory/prompt/default/recall.txt`
- [ ] `memory/engine/recall.ts` 改为通过 loader 加载 prompt，不再直接 import `.txt` 文件
- [ ] 用户在 `.opencode/memory/recall.md` 放置自定义文件时，系统使用用户版本
- [ ] 不放置时行为与现状完全一致
- [ ] Typecheck 通过

### US-004: 外置 Auto-Extract 提示词（P4 + P5）

**Description:** 作为用户，我希望通过 `.opencode/memory/extract.md` 自定义自动提取的策略，控制哪些类型的对话内容应被提取为记忆。

**Acceptance Criteria:**

- [ ] 合并 P4（系统提示词）和 P5（分析提示词）为一个 `extract.md` 文件，用 markdown section 区分
- [ ] 内置默认文件包含两部分：系统提示词部分 + 分析指导部分（含 `<!-- INJECT:CONVERSATION -->` 标记）
- [ ] `memory/engine/extractor.ts` 改为通过 loader 加载 prompt，通过 template 引擎注入会话消息
- [ ] `extractor.ts:128` 的内联系统提示词字符串移除，改为从 extract 文件的系统提示词部分读取
- [ ] `buildAutoExtractPrompt()` 改为从 extract 文件的分析部分读取模板，注入 `<!-- INJECT:CONVERSATION -->`
- [ ] 默认文件中包含注释说明可用变量：`<!-- INJECT:CONVERSATION -->` 代表最近的对话消息
- [ ] 不放置自定义文件时行为与现状完全一致
- [ ] Typecheck 通过

### US-005: 外置 Memory 注入格式模板（P6）

**Description:** 作为用户，我希望通过 `.opencode/memory/inject.md` 自定义 memory 注入到系统提示词时的格式，包括包裹标签、说明文案和冲突警告格式。

**Acceptance Criteria:**

- [ ] 内置默认文件包含两部分：memory 注入格式 + 冲突警告格式
- [ ] 注入格式部分包含 `<!-- INJECT:MEMORY_ITEMS -->` 标记
- [ ] 冲突警告部分包含 `<!-- INJECT:CONFLICT_ITEMS -->` 标记
- [ ] `memory/engine/injector.ts` 的 `formatMemoriesForPrompt()` 改为通过 loader + template 引擎生成
- [ ] `formatConflictWarning()` 同理改造
- [ ] memory 条目的格式化逻辑（`- [category] [scope] content (tags)`）保持不变，作为 `MEMORY_ITEMS` 变量的值
- [ ] 默认文件中包含注释说明可用变量
- [ ] 不放置自定义文件时行为与现状完全一致
- [ ] Typecheck 通过

### US-006: 外置 Optimizer 策略提示词（P7）

**Description:** 作为用户，我希望通过 `.opencode/memory/optimizer.md` 自定义记忆优化策略。

**Acceptance Criteria:**

- [ ] 将现有 `memory/optimizer/default-strategy.md` 内容迁移为内置默认值
- [ ] optimizer 消费侧改为通过 loader 加载，支持用户覆盖
- [ ] 不放置自定义文件时行为与现状完全一致
- [ ] Typecheck 通过

### US-007: /memory 统一命令入口

**Description:** 作为用户，我希望通过 `/memory:remember`、`/memory:forget`、`/memory:list` 统一管理记忆，而不是分散在独立的顶层命令中。

**Acceptance Criteria:**

- [ ] 注册 `/memory` 命令，支持子命令：`remember`、`forget`、`list`
- [ ] `/memory:remember <text>` 行为等同于现有 `/remember`
- [ ] `/memory:forget <id|search>` 行为等同于现有 `/forget`
- [ ] `/memory:list` 调用 `memory_list` 工具展示所有记忆
- [ ] `/memory:remember` 和 `/memory:forget` 的 prompt 模板从 `.opencode/memory/` 目录加载（纳入 prompt 加载器管理）
- [ ] 保留 `/remember` 和 `/forget` 作为向后兼容别名
- [ ] 对应的默认 prompt 文件：`remember.md`、`forget.md`、`list.md`
- [ ] Typecheck 通过

### US-008: 内置默认文件包含教学注释

**Description:** 作为用户，我希望查看内置默认 prompt 文件时能看到清晰的注释，说明如何自定义、有哪些可用变量。

**Acceptance Criteria:**

- [ ] 每个默认 prompt 文件顶部包含 HTML 注释块，说明：
  - 此文件的用途
  - 如何自定义（在 `.opencode/memory/` 下创建同名文件）
  - 可用的模板变量列表及说明（如适用）
- [ ] 注释格式统一，用 `<!-- ... -->` 包裹，不影响 prompt 内容
- [ ] 示例变量说明格式：`<!-- Available variables: -->`、`<!-- INJECT:CONVERSATION - Recent conversation messages (last 20) -->`

### US-009: Prompt 加载器单元测试

**Description:** 作为开发者，我需要全面的单元测试覆盖 prompt 加载器的所有行为。

**Acceptance Criteria:**

- [ ] 测试：指定 name 在无用户文件时返回内置默认值
- [ ] 测试：指定 name 在 `.opencode/memory/` 下有对应文件时返回用户文件内容
- [ ] 测试：多个目录存在同名文件时，高优先级目录的文件胜出
- [ ] 测试：用户文件有 frontmatter 时正确剥离 frontmatter，只返回 body
- [ ] 测试：不合法的 name 参数（非预期值）返回 fallback 或抛错
- [ ] 测试：文件读取失败时（如权限问题）优雅降级到默认值
- [ ] 测试从 `packages/opencode` 目录运行（`do-not-run-tests-from-root` 规则）
- [ ] 不使用 mock 文件系统，使用临时目录 + 真实文件

### US-010: 模板引擎单元测试

**Description:** 作为开发者，我需要全面的单元测试覆盖模板变量替换引擎的所有行为。

**Acceptance Criteria:**

- [ ] 测试：`<!-- INJECT:FOO -->` 被正确替换为 vars.FOO 的值
- [ ] 测试：大小写不敏感匹配（`<!-- inject:foo -->` 也能匹配）
- [ ] 测试：允许空格变体（`<!--INJECT:FOO-->`, `<!-- INJECT: FOO -->`）
- [ ] 测试：未匹配的变量标记保留原文不删除
- [ ] 测试：同一模板中多个不同变量全部替换
- [ ] 测试：同一变量出现多次全部替换
- [ ] 测试：无任何标记的模板原样返回
- [ ] 测试：空模板返回空字符串
- [ ] 测试：vars 值包含特殊字符（如 `$`, `{}`）不被异常处理
- [ ] 测试从 `packages/opencode` 目录运行

### US-011: 覆盖/回退集成测试

**Description:** 作为开发者，我需要集成测试覆盖完整的 prompt 加载 → 模板替换 → 消费侧使用的端到端链路。

**Acceptance Criteria:**

- [ ] 测试：创建临时 `.opencode/memory/recall.md`，验证 `MemoryRecall` 使用自定义内容
- [ ] 测试：创建临时 `.opencode/memory/extract.md` 含 `<!-- INJECT:CONVERSATION -->` 标记，验证注入正确
- [ ] 测试：创建临时 `.opencode/memory/inject.md` 含 `<!-- INJECT:MEMORY_ITEMS -->` 标记，验证格式化输出
- [ ] 测试：删除临时文件后，验证 fallback 到内置默认值
- [ ] 测试：同时存在全局 (`~/.config/opencode/memory/`) 和项目级 (`.opencode/memory/`) 文件时，项目级优先
- [ ] 测试：自定义文件内容为空时不崩溃（返回空字符串或 fallback）
- [ ] 测试从 `packages/opencode` 目录运行
- [ ] 不 mock 文件系统，使用临时目录 + 真实文件写入/读取

### US-012: /memory 命令集成测试

**Description:** 作为开发者，我需要验证 `/memory` 子命令体系正确工作。

**Acceptance Criteria:**

- [ ] 测试：`/memory:remember` 命令注册成功且能获取到对应 prompt
- [ ] 测试：`/memory:forget` 命令注册成功且能获取到对应 prompt
- [ ] 测试：`/memory:list` 命令注册成功且能获取到对应 prompt
- [ ] 测试：向后兼容别名 `/remember` 和 `/forget` 仍然可用
- [ ] 测试：自定义 `.opencode/memory/remember.md` 可覆盖默认 prompt
- [ ] 测试从 `packages/opencode` 目录运行

## Functional Requirements

- FR-1: 新增 `memory/prompt/loader.ts` 模块，提供 `load(name)` 函数按优先级加载 prompt 文件
- FR-2: 新增 `memory/prompt/template.ts` 模块，提供 `render(template, vars)` 函数替换 HTML 注释标记
- FR-3: 支持的固定 prompt 名称：`recall`、`extract`、`inject`、`optimizer`、`remember`、`forget`、`list`
- FR-4: 查找路径遵循 `ConfigPaths.directories()` 返回的目录链，在每个目录下查找 `memory/{name}.md`
- FR-5: 内置默认值存放在 `memory/prompt/default/` 目录下，以 `.txt` 格式保存
- FR-6: 模板变量替换仅作用于 `<!-- INJECT:VAR_NAME -->` 格式的 HTML 注释标记
- FR-7: 未匹配的模板变量标记保留原文，不报错不删除
- FR-8: `MemoryRecall.invoke()` 改为通过 loader 加载 recall prompt
- FR-9: `MemoryExtractor.extractFromSession()` 改为通过 loader 加载 extract prompt，通过 template 引擎注入会话消息
- FR-10: `MemoryInject.formatMemoriesForPrompt()` 和 `formatConflictWarning()` 改为通过 loader + template 引擎生成
- FR-11: optimizer 消费侧改为通过 loader 加载 optimizer prompt
- FR-12: 注册 `/memory` 命令，子命令通过 `:` 分隔符（`/memory:remember`、`/memory:forget`、`/memory:list`）
- FR-13: 保留 `/remember` 和 `/forget` 作为别名，行为与对应的 `/memory:` 子命令一致
- FR-14: prompt 加载器对文件读取失败（权限、损坏等）优雅降级到内置默认值
- FR-15: 内置默认文件包含教学注释，说明自定义方法和可用变量

## Non-Goals

- 不扩展 `config.memory` schema 增加 prompt 相关字段
- 不支持 `opencode.jsonc` 中内联 prompt 文本
- 不更改 Memory 系统的运行时行为逻辑（只改 prompt 来源，不改处理流程）
- 不重构 Memory 系统的存储层、事件系统或 hook 注册机制
- 不支持 frontmatter 中的 `type` 字段识别（用固定文件名替代）
- 不增加 prompt 热重载（需重启或新建 session 生效）
- 不支持 Managed 企业目录下的 memory prompt 覆盖（非优先场景）

## Technical Considerations

### 与现有系统的对齐

- `loadCommand(dir)` 扫描 `{command,commands}/**/*.md`；memory prompt 加载器类似但更简单——固定文件名，无需通配符
- 复用 `ConfigMarkdown.parse()` 处理 frontmatter 剥离
- 复用 `ConfigPaths.directories()` 获取目录链

### 文件结构

```
packages/opencode/src/memory/
├── prompt/
│   ├── loader.ts              # prompt 加载器
│   ├── template.ts            # 模板变量替换引擎
│   └── default/               # 内置默认值
│       ├── recall.txt
│       ├── extract.txt
│       ├── inject.txt
│       ├── optimizer.txt
│       ├── remember.txt
│       ├── forget.txt
│       └── list.txt
├── agent/
│   └── recall.txt             # [删除] 迁移到 prompt/default/recall.txt
├── engine/
│   ├── extractor.ts           # [修改] 使用 loader + template
│   ├── recall.ts              # [修改] 使用 loader
│   └── injector.ts            # [修改] 使用 loader + template
├── optimizer/
│   └── default-strategy.md    # [删除] 迁移到 prompt/default/optimizer.txt
└── ...
```

### 模板变量清单

| 变量名           | 使用场景   | 内容说明                                     |
| ---------------- | ---------- | -------------------------------------------- |
| `CONVERSATION`   | extract.md | 最近 20 条对话消息，格式为 `[role]: content` |
| `MEMORY_ITEMS`   | inject.md  | 格式化的 memory 条目列表                     |
| `CONFLICT_ITEMS` | inject.md  | 格式化的冲突警告列表                         |

### extract.md 内部结构约定

使用 markdown heading 区分系统提示词和分析提示词：

```markdown
<!-- This file defines the auto-extraction prompt for memory system. -->
<!-- To customize, create .opencode/memory/extract.md in your project. -->

# System

You are a memory extraction assistant. Extract persistent preferences
and conventions from development conversations.

# Analysis

Analyze the following development conversation and extract persistent preferences,
code patterns, tool choices, and project conventions worth remembering long-term.

...

<!-- INJECT:CONVERSATION -->
```

代码通过 heading 解析拆分为 system 和 analysis 两部分。

### inject.md 内部结构约定

```markdown
<!-- This file defines how memories are injected into the system prompt. -->
<!-- Available variables: -->
<!-- INJECT:MEMORY_ITEMS - Formatted list of relevant memories -->
<!-- INJECT:CONFLICT_ITEMS - Formatted list of detected conflicts -->

# Memory Injection

<memory>
The following are your memories about this codebase and user preferences.
Use them to inform your responses, but do not mention them explicitly unless asked.

<!-- INJECT:MEMORY_ITEMS -->
</memory>

# Conflict Warning

<memory-conflicts>
Warning: The following memory conflicts were detected. Ask the user to resolve them.

<!-- INJECT:CONFLICT_ITEMS -->
</memory-conflicts>
```

### 性能考量

- prompt 加载器使用 `Instance.state()` 缓存，session 生命周期内只加载一次
- 模板替换使用简单的正则 replace，无性能瓶颈
- 不增加新的 config 文件 watch 或热重载机制

## Success Metrics

- 所有 5 处内置 prompt 可通过 `.opencode/memory/*.md` 覆盖
- 无自定义文件时行为 100% 兼容现状（零回归）
- `/memory:remember`、`/memory:forget`、`/memory:list` 命令正常工作
- `/remember`、`/forget` 别名正常工作
- 单元测试覆盖 loader + template 引擎的所有分支
- 集成测试覆盖覆盖/回退/优先级的端到端链路

## Open Questions

1. `/memory:list` 是否需要支持过滤参数（如 `/memory:list --category=style`）？当前 PRD 定义为调用 `memory_list` 工具的简单包装，过滤功能留给后续迭代。
2. extract.md 中系统提示词和分析提示词通过 `# System` / `# Analysis` heading 拆分——如果用户自定义文件中缺少某个 heading，是报错还是 fallback 到默认值？建议：缺少 heading 时整个文件作为分析提示词使用，系统提示词 fallback 到默认值。
3. 向后兼容别名 `/remember`、`/forget` 是否应在未来版本中标记为 deprecated？建议：是，但不在本次迭代中实现。
