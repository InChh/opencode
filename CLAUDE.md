# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenCode is an open-source AI coding agent with a terminal UI. It's a Bun monorepo with the core CLI/backend in `packages/opencode` and supporting packages for web, desktop, SDK, plugins, and more.

## Commands

```bash
# Development
bun run dev                    # Run opencode in dev mode
bun run typecheck              # Typecheck all packages (via turbo)

# Tests (must run from packages/opencode, NOT root)
cd packages/opencode
bun run test:parallel          # Run all tests in parallel
bun run test:parallel --pattern "**/test/tool/bash.test.ts"  # Single file
bun run test:parallel --workers 4                            # Limit concurrency
bun run test:parallel --stop-on-failure                      # Stop on first fail

# Build
bun run build                  # Build CLI binaries for all platforms
bun run build --single         # Build for current platform only

# Formatting
bun run format                 # Prettier on src/**/*.ts
```

**Important:** `bun test` at the root is intentionally disabled. Always use `test:parallel` from `packages/opencode`.

## Architecture

### Core Loop

```
User Input → Agent Selection → SessionPrompt.build() → LLM.stream()
  → Tool Execution (with hooks + permissions) → Stream Response → Loop
```

Key files in this flow:
- `src/session/prompt.ts` — builds system prompt, message history, runs the step loop
- `src/session/processor.ts` — main event loop, handles retries, compaction, doom loops
- `src/session/llm.ts` — LLM streaming with provider abstraction
- `src/session/message-v2.ts` — structured message/part types and model message conversion

### Plugin + Hook System

**Plugins** (`src/plugin/`) load from npm or filesystem, expose hooks via the `@opencode-ai/plugin` interface. `Plugin.trigger(hookName, input, output)` runs all registered plugin hooks.

**HookChain** (`src/session/hooks/index.ts`) is the internal middleware system with 4 chain types:
- `pre-llm` — modify system prompt, messages, provider options before LLM call
- `pre-tool` — intercept/modify tool args before execution
- `post-tool` — modify tool output after execution (error recovery, truncation)
- `session-lifecycle` — react to session events (created, error, compacting)

Hooks are registered with `HookChain.register(name, chainType, priority, handler)` and organized across files in `src/session/hooks/`:
- `error-recovery.ts` — edit recovery, JSON error recovery, task retry, iterative error detection
- `context-injection.ts` — agents, readme, rules injection into system prompt
- `detection-checking.ts` — keyword detection, comment checking, write guards
- `output-management.ts` — tool output truncation, context window monitoring
- `agent-enforcement.ts` — subagent question blocking, todo continuation
- `llm-parameters.ts` — think mode, effort level
- `session-lifecycle.ts` — session recovery, notification, babysitter

### Provider System

`src/provider/provider.ts` abstracts 25+ AI providers (Anthropic, OpenAI, Google, Azure, Bedrock, etc.) via the `ai` SDK. Models are defined in `src/provider/snapshot/` with capabilities, costs, and limits. Custom loaders handle provider-specific auth and headers.

### Tool System

`src/tool/` contains 70+ tools. Each tool uses `Tool.define(id, { parameters, execute })` with Zod schema validation. The tool registry (`src/tool/registry.ts`) merges built-in, config, and plugin tools. Tools execute within permission checks and optional OS-level sandboxing.

### Agent System

`src/agent/agent.ts` defines agent profiles (sisyphus, build, plan, explore, oracle, compaction) with per-agent model selection, permissions, and prompt templates. Prompt variants in `src/agent/prompt/` customize behavior for different models.

### Key Supporting Systems

- **Config** (`src/config/config.ts`) — layered config: remote → global → project (`opencode.json`) → env
- **Security** (`src/security/`) — allowlist/deny rules, bash scanning, LLM injection detection, audit logging
- **Sandbox** (`src/sandbox/`) — OS-native process isolation (macOS Seatbelt, Linux Landlock)
- **MCP** (`src/mcp/`) — Model Context Protocol client supporting stdio, HTTP, SSE transports
- **Storage** (`src/storage/`) — Drizzle ORM with SQLite for sessions, messages, parts
- **Bus** (`src/bus/`) — per-instance event system with publish/subscribe
- **Instance** (`src/project/instance.ts`) — per-directory context with `Instance.state()` for isolated state

## Conventions

- **Namespaces over classes**: Code is organized using `export namespace` (e.g., `Provider`, `Session`, `Config`), not OOP classes
- **Instance-scoped state**: Use `Instance.state(() => initialState)` for per-directory singleton state
- **Path aliases**: `@/*` maps to `src/*`, `@tui/*` maps to `src/cli/cmd/tui/*`
- **Named errors**: Use `NamedError.create(name, schema)` for typed errors with `.isInstance()` checking
- **Logging**: `Log.create({ service: "name" })` for structured logging
- **Tool definitions**: `Tool.define(id, { parameters: z.object({...}), execute })` with Zod schemas
- **Event definitions**: `BusEvent.define(type, schema)` for typed pub/sub
- **Validated functions**: `fn(schema, callback)` wraps functions with Zod parameter validation
- **No semicolons**: Prettier configured with `semi: false`, `printWidth: 120`
- **TUI error output**: Never use `console.error()`/`console.log()` in TUI mode — use `Bus.publish(TuiEvent.ToastShow, ...)` for user-visible messages, `Log.error()` for log output

## OMO (oh-my-opencode) Sync

The project internalizes components from the `oh-my-opencode` npm package. The baseline is tracked in `packages/opencode/.omo-baseline.json`. Use `/omo-sync` to fetch, diff, and backport new features. The sync ledger lives at `.claude/state/omo-sync-ledger.json`.
