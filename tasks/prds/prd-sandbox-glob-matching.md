# PRD: Sandbox Glob Pattern Matching

## Introduction

当前 sandbox（OS 原生沙箱）层的 deny/allowlist 规则只支持具体路径（seatbelt 的 `literal` 和 `subpath`），无法处理含通配符的 glob 模式（如 `*secretchat*`、`**/*.key`）。这导致应用层（`SecurityAccess`）能用 minimatch 正确匹配 glob，但 sandbox 内核层的 glob 模式会被错误地当作字面路径处理，形成安全策略不一致。

本 PRD 的目标是让 sandbox 策略生成支持 glob 模式，通过将 glob 转换为 seatbelt `(regex ...)` 过滤器实现内核级 glob 匹配，并在接口层预留 Linux Landlock 的扩展能力。

## Goals

- 让 sandbox deny 和 allowlist 规则都支持含通配符的 glob 模式
- 将 glob 模式转换为 macOS seatbelt 的 `(regex ...)` 过滤器
- 在接口层预留 Linux Landlock 平台的 glob 转换能力
- 保持具体路径（无通配符）使用现有的 `literal`/`subpath`（性能最优）
- 提供完整的单元测试和集成测试覆盖

## User Stories

### US-001: Glob 转 Regex 核心转换模块

**Description:** As a developer, I need a utility that converts glob patterns to seatbelt-compatible regex strings so that the sandbox profile generator can use regex filters for glob patterns.

**Acceptance Criteria:**

- [ ] 新建 `src/sandbox/glob-to-regex.ts` 模块，导出 `globToSbplRegex(pattern: string, projectRoot: string): string` 函数
- [ ] 支持以下 glob 语法：
  - `*` — 匹配任意字符（不跨 `/`），转为 `[^/]*`
  - `**` — 匹配任意层级目录（跨 `/`），转为 `.*`
  - `?` — 匹配单个字符，转为 `[^/]`
  - `{a,b}` — 花括号展开（可选，MVP 可不支持）
- [ ] **Glob 匹配整条路径**，严格遵循标准 glob 语义：`*` 不跨 `/`，跨目录必须用 `**`。例如 `**/*secretchat*` 匹配任意层级路径中文件名包含 secretchat 的文件，而 `*secretchat*` 仅匹配项目根目录下的文件
- [ ] 相对路径基于 `projectRoot` 转为绝对路径后再生成 regex
- [ ] **固定前缀解析**：遇到第一个含通配符的路径段时停止 realpath 解析。例如 `src/lib*/*.key` 的固定前缀是 `src`（`lib*` 含通配符，停止），对 `src` 做 realpath 解析后拼接后续 glob 段
- [ ] 输出的 regex 字符串可直接用于 seatbelt 的 `(regex "...")` 表达式（POSIX ERE）
- [ ] 对特殊字符（`.`、`(`、`)`、`+` 等）正确转义
- [ ] Typecheck 通过

### US-002: Profile 生成器集成 glob 检测与分发

**Description:** As a developer, I need the profile generator to detect glob patterns and automatically choose between `literal`/`subpath`（具体路径）and `regex`（glob 模式），so that the generated seatbelt policy correctly handles both cases.

**Acceptance Criteria:**

- [ ] 修改 `src/sandbox/profile.ts` 的 `resolveDenyEntry` 和 `resolveAllowlistEntry`
- [ ] 新增 `isGlobPattern(pattern: string): boolean` 辅助函数，检测 pattern 是否包含 `*`、`?`、`{`、`[` 等通配符
- [ ] 当 `isGlobPattern` 返回 `true` 时，调用 `globToSbplRegex` 生成 `(regex ...)` 规则
- [ ] 当 `isGlobPattern` 返回 `false` 时，保持现有 `literal`/`subpath` 行为不变
- [ ] **Glob pattern 忽略 `type: "directory" | "file"` 字段**——regex 匹配整条路径，不区分文件和目录
- [ ] 生成的 deny 规则格式：`(deny file-read* file-write* (regex "^/abs/path/.*pattern.*$"))`
- [ ] 生成的 allowlist 规则格式：`(allow file-write* (regex "^/abs/path/.*\\.ts$"))`
- [ ] **deny regex 规则放在 allowlist regex 规则之后**，确保 deny 优先级高于 allow（seatbelt last-match-wins）
- [ ] Typecheck 通过

### US-003: deniedOperations 与 sandbox deny 的联动

**Description:** As a developer, I need the sandbox profile generator to respect `deniedOperations` from security rules, so that deny-write-only rules don't generate sandbox deny entries (since sandbox deny blocks both read and write).

**Acceptance Criteria:**

- [ ] 修改 `src/sandbox/init.ts` 中提取 deny patterns 的逻辑
- [ ] **仅当 `deniedOperations` 包含 `"read"`（或包含 `"llm"`，因为 `llm` 等于 deny read+write）时**，才将该 rule 的 pattern 传入 sandbox deny
- [ ] **当 `deniedOperations` 仅包含 `"write"`（不含 `"read"` 和 `"llm"`）时**，不生成 sandbox deny 规则（因为 sandbox 无法单独 deny write 而 allow read）
- [ ] 传递 `deniedOperations` 信息到 `SandboxConfig`，而非仅传 pattern 字符串
- [ ] Typecheck 通过

### US-004: SandboxConfig 接口预留平台抽象

**Description:** As a developer, I need the SandboxConfig and Sandbox interfaces to support platform-agnostic glob conversion so that Linux Landlock can later implement its own glob handling.

**Acceptance Criteria:**

- [ ] 在 `src/sandbox/index.ts` 的 `SandboxConfig` 接口中，allowlist 和 deny 的条目保留 `pattern` 原始字符串（不在接口层预处理 glob）
- [ ] glob 检测和转换逻辑放在 profile 生成层（`profile.ts`），不放在 `SeatbeltSandbox` 类中，使不同平台可以各自实现转换
- [ ] `seatbelt.ts` 中 `generatePolicy` 的 pattern 类型判断兼容 glob 模式——含通配符的 pattern 不再通过 `!pattern.includes(".")` 猜测 type，直接透传
- [ ] Typecheck 通过

### US-005: 单元测试 — glob 转 regex

**Description:** As a developer, I need comprehensive unit tests for the glob-to-regex conversion to ensure correctness.

**Acceptance Criteria:**

- [ ] 新建 `test/sandbox/glob-to-regex.test.ts`
- [ ] 测试覆盖以下 pattern（regex 匹配整条路径）：
  - `*secretchat*` → 仅匹配项目根目录下文件名含 secretchat 的文件（不跨目录）
  - `**/*secretchat*` → 匹配任意层级下文件名含 secretchat 的文件（跨目录）
  - `**/*.key` → 匹配任意层级下的 .key 文件
  - `src/**/*.test.ts` → 匹配 src 下任意层级的 .test.ts 文件
  - `*.swift` → 匹配当前目录下的 .swift 文件
  - `src/Crypto*.swift` → 匹配 src 下 Crypto 开头的 .swift 文件
  - `src/lib*/*.key` → 固定前缀为 `src`，匹配 `src/lib-xxx/foo.key`
  - 无通配符路径 → 验证 `isGlobPattern` 返回 false
- [ ] 验证特殊字符转义（`.`、`(`、`+` 等不被误解为 regex 元字符）
- [ ] 验证 projectRoot 拼接和固定前缀 realpath 解析
- [ ] 所有测试通过 `bun run test:parallel --pattern "**/test/sandbox/glob-to-regex.test.ts"`

### US-006: 集成测试 — sandbox profile 含 glob 规则

**Description:** As a developer, I need integration tests verifying that glob patterns in deny/allowlist produce correct seatbelt profiles.

**Acceptance Criteria:**

- [ ] 新建 `test/sandbox/profile-glob.test.ts`
- [ ] 测试 `generateProfile` 和 `generateFullProfile`：
  - deny 含 glob pattern → 输出 `(deny ... (regex "..."))` 规则
  - allowlist 含 glob pattern → 输出 `(allow ... (regex "..."))` 规则
  - 混合具体路径和 glob → 具体路径用 literal/subpath，glob 用 regex
  - **deny regex 出现在 allowlist regex 之后**（验证 last-match-wins 优先级）
- [ ] 测试 deniedOperations 联动：
  - `deniedOperations: ["read", "write"]` → 生成 sandbox deny
  - `deniedOperations: ["llm"]` → 生成 sandbox deny（llm = read + write）
  - `deniedOperations: ["write"]` → 不生成 sandbox deny
- [ ] 测试 `seatbelt.ts` 的 `generatePolicy` 端到端
- [ ] 所有测试通过

### US-007: sandbox status 展示 regex 规则

**Description:** As a user, I want `sandbox status` to clearly show which rules use regex (from glob) versus literal/subpath, so I can verify my glob patterns are correctly converted.

**Acceptance Criteria:**

- [ ] `lark-opencode sandbox status` 的 SBPL Profile 输出中，regex 规则带注释标注原始 glob pattern
- [ ] 格式示例：`;; glob: *secretchat*` 后跟 `(deny ... (regex "..."))`
- [ ] 现有 literal/subpath 规则输出不变
- [ ] Typecheck 通过

## Functional Requirements

- FR-1: 新增 `globToSbplRegex(pattern, projectRoot)` 函数，将 glob 模式转换为 seatbelt regex 字符串
- FR-2: 新增 `isGlobPattern(pattern)` 函数，检测 pattern 是否包含通配符（`*`、`?`、`[`、`{`）
- FR-3: `resolveDenyEntry` 对含通配符的 pattern 生成 `(deny file-read* file-write* (regex "..."))` 规则
- FR-4: `resolveAllowlistEntry` 对含通配符的 pattern 生成 `(allow file-write* (regex "..."))` 规则
- FR-5: 不含通配符的 pattern 保持现有 `literal`/`subpath` 行为不变
- FR-6: glob 中 `*` 转为 `[^/]*`（不跨目录），`**` 转为 `.*`（跨目录），`?` 转为 `[^/]`
- FR-7: 生成的 regex 以 `^` 开头、`$` 结尾，确保全路径匹配；严格标准 glob 语义，`*` 不跨 `/`，跨目录必须用 `**`
- FR-8: profile 输出中 regex 规则前添加注释标注原始 glob pattern
- FR-9: glob pattern 忽略 `type: "directory" | "file"` 字段，regex 统一匹配整条路径
- FR-10: deny regex 规则在 profile 中排列在 allowlist regex 之后，确保 deny 优先（seatbelt last-match-wins）
- FR-11: `deniedOperations` 联动——仅当 deny 包含 `"read"` 或 `"llm"` 时才生成 sandbox deny 规则；仅 `"write"` 时不生成（sandbox 无法单独 deny write）
- FR-12: 固定前缀 realpath 解析——按路径段拆分，遇到第一个含通配符的段时停止，对前缀做 realpath，后续 glob 段保留拼接

## Non-Goals

- 不实现 Linux Landlock 的 glob 支持（仅预留接口）
- 不支持 `{a,b}` 花括号展开（MVP 阶段）
- 不修改 `.opencode-security.json` 的 schema 格式
- 不修改应用层（`SecurityAccess`）的 minimatch 逻辑
- 不实现运行时文件系统扫描/枚举方式

## Technical Considerations

- **seatbelt regex 方言：** macOS seatbelt 使用 POSIX Extended Regular Expressions (ERE)，不支持 `\d`、`\w` 等 PCRE 扩展，需使用 `[0-9]`、`[a-zA-Z_]` 等
- **性能：** `(regex ...)` 比 `(literal ...)` 和 `(subpath ...)` 慢，应仅对含通配符的 pattern 使用 regex，具体路径保持原有方式
- **realpath 固定前缀解析：** 按 `/` 拆分路径段，从左向右扫描，遇到第一个含 `*`/`?`/`[`/`{` 的段时停止。对前缀部分做 realpath 解析（处理 symlink），后续 glob 段保持原样拼接。例如 `src/lib*/*.key` → realpath(`src`) + `/lib*/*.key`
- **seatbelt 规则顺序（last-match-wins）：** deny regex 必须排在 allow regex 之后。当前 profile 生成顺序：builtins(deny all writes) → allowlist rules → deny rules。deny 在最后，已满足 last-match-wins 语义
- **deniedOperations 过滤：** sandbox 的 deny 是 `file-read* file-write*` 联合的，无法只 deny write。因此仅 `["write"]` 的规则不传入 sandbox，避免过度限制（用户配置只禁写不禁读，sandbox 不应把读也禁了）
- **glob pattern 与 type 字段：** glob pattern 匹配整条路径，`type: "directory" | "file"` 字段被忽略。regex 不区分文件和目录
- **依赖：** 不引入新的外部依赖，glob-to-regex 转换纯手写

## Success Metrics

- `.opencode-security.json` 中配置 `*secretchat*` deny 规则后，`sandbox status` 正确输出 regex 规则
- 在 sandbox 环境中，bash 命令无法读写匹配 glob pattern 的文件
- 所有现有 sandbox 测试继续通过（无回归）
- 新增 glob-to-regex 单元测试和 profile 集成测试全部通过

## Open Questions

- seatbelt 的 regex 过滤器对路径匹配的性能影响有多大？大量 regex 规则是否有上限？
- 是否需要支持否定模式（`!pattern`）？
- `realpath` 对 glob 前缀的解析是否需要处理 symlink（如 `src` 是 symlink 的情况）？
