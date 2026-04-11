# PRD: 同目录多独立实例支持

## Introduction

在原有 Remote Attach Session 共享架构（参见 `prd-remote-attach-session-sharing.md`）中，同一目录下只允许运行一个 Worker 进程（通过 `worker.lock` 互斥）。第二个打开的 `opencode` TUI 会发现已有 Worker，连接为 observer，必须通过 takeover 才能获得写权限。

这在实际使用中存在不便：用户经常需要在同一项目目录下开多个独立的 opencode 实例，各自独立工作（不同 session、不同任务），而非"观察"另一个实例。

本特性将 lockfile 机制从"per-directory 单实例"改为"per-directory 多实例"，每次 `opencode` 启动都创建独立的 Worker，互不干扰。`attach` 连接到已有实例的场景继续沿用 observer/takeover 机制。

### 与原 PRD 的关系

本 PRD 是对 `prd-remote-attach-session-sharing.md` 中 US-012（TUI 架构统一为 Serve + Attach）的增量修订。原 PRD 中以下设计决策被本特性覆盖：

- ~~"Worker 进程 per-directory 全局唯一"~~ → 同目录可有多个 Worker
- ~~"互斥保护：TUI 检测到 lock file 已存在直接 attach"~~ → TUI 总是启动新 Worker
- ~~"worker.lock 单文件"~~ → `worker-{pid}.lock` 多文件

**未变更的部分：**
- `attach <url>` 连接已有实例 → observer/takeover 机制不变
- Worker 生命周期（`--mode=auto` 自动退出、grace period）不变
- Client 注册、reconnect token、owner/observer 角色模型不变（在单个 Worker 内部）
- Auth token 认证机制不变

## Goals

- 同一目录下的每个 `opencode` TUI 启动独立的 Worker 进程，各自独立工作
- `opencode stop` 能停止当前目录下所有 Worker，或指定 PID 停止特定 Worker
- `opencode attach` 继续沿用现有 observer/takeover 逻辑（per-Worker 单 owner）
- 共享 SQLite 数据库（session、message 等数据在所有实例间可见）

## Non-Goals

- 不改变 Instance 内部的 owner/observer 模型
- 不引入实例间通信或协调机制
- 不改变 `opencode serve` 的行为（仍可独立启动 headless server）

## Design

### Lock File 变更

**路径变更：**
```
# 旧格式（单实例）
$XDG_DATA_HOME/opencode/<dir-hash>/worker.lock

# 新格式（多实例）
$XDG_DATA_HOME/opencode/<dir-hash>/worker-<pid>.lock
```

每个 Worker 进程创建以自身 PID 命名的 lockfile。同目录下可同时存在多个 lockfile。

**新增 API：**
- `Lockfile.list(dir)` — 列出目录下所有存活的 Worker lockfile，清理 stale 条目
- `Lockfile.removeAll(dir)` — 删除目录下所有 lockfile

**变更 API：**
- `Lockfile.filepath(dir, pid?)` — 生成 PID 特定的 lockfile 路径
- `Lockfile.read(dir, pid?)` — 读取特定 PID 的 lockfile
- `Lockfile.acquire(dir, pid?)` — 获取特定 PID 的 lockfile（含 stale 检查）
- `Lockfile.remove(dir, pid?)` — 删除特定 PID 的 lockfile

### TUI 启动流程变更

**旧流程：**
1. 检查 lockfile → 存在则连接已有 Worker（成为 observer）
2. 不存在 → spawn 新 Worker

**新流程：**
1. 记录当前已有 Worker PID 集合（`Lockfile.list(dir)`）
2. 总是 spawn 新 Worker
3. 等待新 lockfile 出现（排除已有 PID）
4. 连接新 Worker（成为该 Worker 的唯一 owner）

### Serve 命令变更

移除互斥检查（"另一个 worker 已在运行"错误），允许多个 `opencode serve` 并行运行。

### Stop 命令变更

- 无参数：停止当前目录下所有 Worker
- `--pid <pid>`：停止指定 PID 的 Worker

## User Stories

### US-MI-001: 同目录启动多个独立 TUI

**Description:** 作为开发者，我需要在同一项目目录下同时打开多个 opencode TUI，各自独立工作。

**Acceptance Criteria:**

- [x] 每次 `opencode` 启动都 spawn 新的 Worker 进程（不复用已有 Worker）
- [x] 新 Worker 使用独立端口，创建独立 lockfile（`worker-{pid}.lock`）
- [x] TUI 连接到自己的 Worker，自动成为 owner
- [x] 多个实例各自独立操作，互不干扰
- [x] 共享同一个 SQLite 数据库，session 数据可见
- [x] Typecheck 通过

### US-MI-002: Stop 所有或指定 Worker

**Description:** 作为开发者，我需要停止当前目录下的所有 Worker，或指定停止某个 Worker。

**Acceptance Criteria:**

- [x] `opencode stop` 遍历目录下所有 `worker-*.lock` 文件，逐一发送 SIGTERM
- [x] `opencode stop --pid <pid>` 仅停止指定 PID 的 Worker
- [x] 无存活 Worker 时输出提示信息
- [x] Typecheck 通过

### US-MI-003: Attach 沿用现有 takeover 逻辑

**Description:** 作为远程用户，通过 `attach` 连接已有 Worker 时，仍遵循 observer/takeover 角色模型。

**Acceptance Criteria:**

- [x] `opencode attach <url>` 连接到目标 Worker，作为 observer 加入
- [x] Observer 可通过 `<leader>o` 请求 takeover
- [x] 强制 takeover（force=true）和普通 takeover 逻辑不变
- [x] Cooldown 机制不变

## Changed Files

| File | Change |
|------|--------|
| `src/server/lockfile.ts` | lockfile 从 `worker.lock` 改为 `worker-{pid}.lock`；新增 `list()`、`removeAll()`；`filepath/read/acquire/remove` 增加 `pid` 参数 |
| `src/cli/cmd/tui/thread.ts` | 删除"复用已有 Worker"逻辑，总是 spawn 新 Worker；`waitForLockfile` 改为 `waitForNewLockfile`（排除已有 PID） |
| `src/cli/cmd/serve.ts` | 移除"另一个 worker 已在运行"互斥检查 |
| `src/cli/cmd/stop.ts` | 支持 `--pid` 参数；无参数时停止所有 Worker |
| `src/cli/cmd/tui/worker.ts` | lockfile 冲突从静默退出改为错误退出（同 PID 重复仅在极端竞态下发生） |
| `test/server/remote-attach.test.ts` | 更新 lockfile 测试；新增多实例 lockfile 测试（`list`、`removeAll`、不同 PID 共存） |

## Test Cases

### Lockfile 单元测试（已实现）

| Test | Description |
|------|-------------|
| create and read lock file | 创建 lockfile 后能正确读取 |
| create fails when lock file with same PID exists | 同 PID 重复创建返回 false |
| create succeeds for different PIDs in same directory | 不同 PID 可在同目录创建独立 lockfile |
| acquire returns data for alive process | 存活进程的 lockfile 可正常获取 |
| acquire cleans stale lock (dead PID) | 死进程的 lockfile 被自动清理 |
| read returns undefined for missing file | 不存在的 lockfile 返回 undefined |
| list returns all live lock files | 列出所有存活 Worker，清理 stale |
| list returns empty for nonexistent directory | 不存在的目录返回空 |
| removeAll clears all lock files | 清除所有 lockfile |

### 建议补充的集成测试

| Test | Description |
|------|-------------|
| Two TUI instances spawn independent Workers | 两个 TUI 在同目录各自 spawn 独立 Worker，各自获得 owner 角色 |
| Stop all Workers | `opencode stop` 能停止同目录所有 Worker |
| Stop specific Worker by PID | `opencode stop --pid` 仅停止指定 Worker |
| Attach to specific Worker stays observer | `attach` 到某个 Worker 后，角色为 observer |
| Worker auto-exit after TUI disconnect | `--mode=auto` 的 Worker 在 TUI 断开后自动退出 |
| Stale lockfile cleanup on list | `list()` 自动清理 stale lockfile |
| Database shared across instances | 多个实例共享同一 SQLite，session 数据互通 |
