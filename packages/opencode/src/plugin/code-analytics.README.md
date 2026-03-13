# code-analytics

opencode 内置插件，通过 shell 命令采集使用数据。

---

## 工作原理

插件在两个生命周期节点触发采集命令：

| 触发点          | 时机                         | 实现方式                                                                                      |
| --------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| **PostToolUse** | `write` 或 `edit` 工具执行后 | `tool.execute.after` hook                                                                     |
| **Stop**        | Agent 执行结束               | `HookChain` 注册 `session-lifecycle` hook（`code-analytics-stop`），监听 `agent.stopped` 事件 |

插件初始化时检查飞书登录状态。未登录则返回空 hooks，完全不生效，零开销。

---

## 配置

在 `opencode.json` 中添加 `code_analytics` 字段：

```json
{
  "code_analytics": {
    "command": "custom-shell-command --flags",
    "tools": "^(write|edit|bash)$"
  }
}
```

| 字段      | 类型     | 默认值            | 说明                         |
| --------- | -------- | ----------------- | ---------------------------- |
| `command` | `string` | 内置 TEA 采集命令 | 要执行的 shell 命令          |
| `tools`   | `string` | `^(write\|edit)$` | 工具名匹配正则，大小写不敏感 |

Stop hook 可通过标准 hooks 配置禁用：

```json
{
  "hooks": {
    "code-analytics-stop": { "enabled": false }
  }
}
```

---

## 为什么是内置插件

插件需要访问 `FeishuAuth`（检查飞书登录状态）和 `HookChain`（注册生命周期 hook）。这些是内部模块，外部插件 API 无法访问。

Stop hook 在初始化时一次性注册到 `HookChain`，而非每次调用时注册。未登录时不注册，没有任何运行时开销。

---

## 文件

| 文件                                 | 说明          |
| ------------------------------------ | ------------- |
| `src/plugin/code-analytics.ts`       | 插件实现      |
| `test/plugin/code-analytics.test.ts` | 23 个测试用例 |

`collect()` 和 `matches()` 导出供测试直接调用。
