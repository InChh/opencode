import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { FeishuAuth } from "../../src/auth/feishu"
import { HookChain } from "../../src/session/hooks"
import { matches } from "../../src/plugin/code-analytics"

// --- Unit tests for tool matcher ---

describe("code-analytics", () => {
  describe("tool matcher", () => {
    test("matches write tool", () => {
      expect(matches("write")).toBe(true)
    })

    test("matches edit tool", () => {
      expect(matches("edit")).toBe(true)
    })

    test("matches case-insensitive", () => {
      expect(matches("Write")).toBe(true)
      expect(matches("EDIT")).toBe(true)
    })

    test("does not match read tool", () => {
      expect(matches("read")).toBe(false)
    })

    test("does not match bash tool", () => {
      expect(matches("bash")).toBe(false)
    })

    test("does not match grep tool", () => {
      expect(matches("grep")).toBe(false)
    })

    test("does not match glob tool", () => {
      expect(matches("glob")).toBe(false)
    })

    test("does not match partial names", () => {
      expect(matches("rewrite")).toBe(false)
      expect(matches("editor")).toBe(false)
      expect(matches("multiEdit")).toBe(false)
    })
  })

  // --- Custom pattern ---

  describe("tool matcher with custom pattern", () => {
    test("custom pattern matches specified tools", () => {
      expect(matches("write", "^(write|edit|bash)$")).toBe(true)
      expect(matches("bash", "^(write|edit|bash)$")).toBe(true)
    })

    test("custom pattern rejects unmatched tools", () => {
      expect(matches("read", "^(write|edit|bash)$")).toBe(false)
    })

    test("custom pattern is case-insensitive", () => {
      expect(matches("WRITE", "^write$")).toBe(true)
    })
  })

  // --- Plugin init behavior ---

  describe("plugin init", () => {
    async function withInstance(fn: () => Promise<void>) {
      await using tmp = await tmpdir({ git: true, config: {} })
      await Instance.provide({
        directory: tmp.path,
        fn,
      })
    }

    beforeEach(async () => {
      await FeishuAuth.remove()
      HookChain.reset()
    })

    afterEach(async () => {
      await FeishuAuth.remove()
      HookChain.reset()
    })

    test("returns empty hooks when feishu not logged in", async () => {
      await withInstance(async () => {
        const { CodeAnalyticsPlugin } = await import("../../src/plugin/code-analytics")
        const hooks = await CodeAnalyticsPlugin({} as any)
        expect(hooks["tool.execute.after"]).toBeUndefined()
        expect(
          HookChain.listRegistered("session-lifecycle").find((h) => h.name === "code-analytics-stop"),
        ).toBeUndefined()
      })
    })

    test("returns hooks when feishu is logged in", async () => {
      await withInstance(async () => {
        await FeishuAuth.write({
          refresh_token: "rt_test",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          name: "Test User",
          email: "test@example.com",
          wellknown_url: "https://ai.corp.com",
        })

        const { CodeAnalyticsPlugin } = await import("../../src/plugin/code-analytics")
        const hooks = await CodeAnalyticsPlugin({} as any)
        expect(hooks["tool.execute.after"]).toBeDefined()
        expect(typeof hooks["tool.execute.after"]).toBe("function")
      })
    })

    test("registers session-lifecycle hook when feishu is logged in", async () => {
      await withInstance(async () => {
        await FeishuAuth.write({
          refresh_token: "rt_test",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          name: "Test User",
          email: "test@example.com",
          wellknown_url: "https://ai.corp.com",
        })

        const { CodeAnalyticsPlugin } = await import("../../src/plugin/code-analytics")
        await CodeAnalyticsPlugin({} as any)

        const hooks = HookChain.listRegistered("session-lifecycle")
        const found = hooks.find((h) => h.name === "code-analytics-stop")
        expect(found).toBeDefined()
        expect(found!.enabled).toBe(true)
      })
    })
  })

  // --- HookChain integration ---

  describe("hook chain integration", () => {
    async function withInstance(fn: () => Promise<void>) {
      await using tmp = await tmpdir({ git: true, config: {} })
      await Instance.provide({
        directory: tmp.path,
        fn,
      })
    }

    beforeEach(async () => {
      HookChain.reset()
    })

    afterEach(async () => {
      await FeishuAuth.remove()
      HookChain.reset()
    })

    test("stop hook fires on agent.stopped event", async () => {
      await withInstance(async () => {
        let fired = false
        HookChain.register("code-analytics-stop", "session-lifecycle", 400, async (ctx) => {
          if (ctx.event !== "agent.stopped") return
          fired = true
        })

        await HookChain.execute("session-lifecycle", {
          sessionID: "s-test-1",
          event: "agent.stopped",
          agent: "build",
        })

        expect(fired).toBe(true)
      })
    })

    test("stop hook does not fire on other events", async () => {
      await withInstance(async () => {
        let fired = false
        HookChain.register("code-analytics-stop", "session-lifecycle", 400, async (ctx) => {
          if (ctx.event !== "agent.stopped") return
          fired = true
        })

        await HookChain.execute("session-lifecycle", {
          sessionID: "s-test-2",
          event: "session.created",
        })

        expect(fired).toBe(false)
      })
    })

    test("stop hook can be disabled via config", async () => {
      await withInstance(async () => {
        let fired = false
        HookChain.register("code-analytics-stop", "session-lifecycle", 400, async (ctx) => {
          if (ctx.event !== "agent.stopped") return
          fired = true
        })

        HookChain.reloadConfig({ "code-analytics-stop": { enabled: false } })

        await HookChain.execute("session-lifecycle", {
          sessionID: "s-test-3",
          event: "agent.stopped",
          agent: "build",
        })

        expect(fired).toBe(false)
      })
    })
  })

  // --- PostToolUse hook behavior ---

  describe("tool.execute.after hook", () => {
    test("calls handler for write tool", async () => {
      let called = false
      const hook = async (ctx: { tool: string }) => {
        if (!matches(ctx.tool)) return
        called = true
      }

      await hook({ tool: "write" })
      expect(called).toBe(true)
    })

    test("calls handler for edit tool", async () => {
      let called = false
      const hook = async (ctx: { tool: string }) => {
        if (!matches(ctx.tool)) return
        called = true
      }

      await hook({ tool: "edit" })
      expect(called).toBe(true)
    })

    test("does not call handler for read tool", async () => {
      let called = false
      const hook = async (ctx: { tool: string }) => {
        if (!matches(ctx.tool)) return
        called = true
      }

      await hook({ tool: "read" })
      expect(called).toBe(false)
    })

    test("does not call handler for bash tool", async () => {
      let called = false
      const hook = async (ctx: { tool: string }) => {
        if (!matches(ctx.tool)) return
        called = true
      }

      await hook({ tool: "bash" })
      expect(called).toBe(false)
    })
  })

  // --- Config-driven behavior ---

  describe("config", () => {
    test("collect uses provided command", async () => {
      // Just verify collect() accepts a command argument without error
      // The actual command execution is best tested via integration tests
      const { collect } = await import("../../src/plugin/code-analytics")
      // "true" is a no-op command that always succeeds
      await collect("true")
    })

    test("custom tools pattern changes matching", () => {
      // Default: only write|edit
      expect(matches("bash")).toBe(false)

      // Custom: include bash
      expect(matches("bash", "^(write|edit|bash)$")).toBe(true)

      // Custom: only write
      expect(matches("edit", "^write$")).toBe(false)
      expect(matches("write", "^write$")).toBe(true)
    })
  })
})
