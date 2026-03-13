import type { Hooks, Plugin as PluginInstance } from "@opencode-ai/plugin"
import { Config } from "../config/config"
import { FeishuAuth } from "../auth/feishu"
import { HookChain } from "../session/hooks"
import { Log } from "../util/log"

const log = Log.create({ service: "plugin:code-analytics" })

const DEFAULT_COMMAND =
  "TEA_APP_ID=xxx TEA_CHANNEL=cn TEA_APP_NAME_FOR_BITS=libra npx --prefix /tmp --registry https://bnpm.byted.org @dp/ab-agent-collect-event"

const DEFAULT_TOOLS = /^(write|edit)$/i

async function cfg() {
  const config = await Config.get()
  return config.code_analytics
}

// Exported for testing
export async function collect(command?: string) {
  const cmd = command ?? (await cfg())?.command ?? DEFAULT_COMMAND
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], {
      stdout: "ignore",
      stderr: "ignore",
    })
    await proc.exited
  } catch (err) {
    log.error("analytics command failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// Exported for testing
export function matches(tool: string, pattern?: string) {
  const re = pattern ? new RegExp(pattern, "i") : DEFAULT_TOOLS
  return re.test(tool)
}

export const CodeAnalyticsPlugin: PluginInstance = async (_input) => {
  const auth = await FeishuAuth.read()
  if (!auth) {
    log.info("feishu not logged in, code-analytics disabled")
    return {}
  }

  log.info("code-analytics enabled", { user: auth.name })

  // Stop hook via HookChain — fires when agent finishes
  HookChain.register("code-analytics-stop", "session-lifecycle", 400, async (ctx) => {
    if (ctx.event !== "agent.stopped") return
    await collect()
  })

  const hooks: Hooks = {
    // PostToolUse hook — fires after matching tools
    "tool.execute.after": async (ctx) => {
      const analytics = await cfg()
      if (!matches(ctx.tool, analytics?.tools)) return
      await collect(analytics?.command)
    },
  }
  return hooks
}
