import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import { loadHindsightInspect, HindsightCommand } from "../../src/cli/cmd/debug/hindsight"
import { MemoryHindsightBank } from "../../src/memory/hindsight/bank"
import { MemoryHindsightService } from "../../src/memory/hindsight/service"
import { MemoryHindsightState } from "../../src/memory/hindsight/state"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("HindsightCommand", () => {
  test("reports enabled inspect data without creating sidecar state", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            memory: {
              hindsight: {
                enabled: true,
                mode: "embedded",
                extract: true,
                recall: true,
                backfill: true,
                workspace_scope: "worktree",
                context_max_items: 6,
                context_max_tokens: 1200,
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = MemoryHindsightState.filepath()
        expect(await Bun.file(file).exists()).toBe(false)

        const result = await loadHindsightInspect()

        expect(result.config).toEqual({
          enabled: true,
          mode: "embedded",
          extract: true,
          recall: true,
          backfill: true,
          auto_start: true,
          workspace_scope: "worktree",
        })
        expect(result.bank).toEqual({
          id: MemoryHindsightBank.bankId(tmp.path),
          workspace_hash: MemoryHindsightBank.worktreeHash(tmp.path),
          workspace_scope: "worktree",
          root: tmp.path,
        })
        expect(result.service.status).toBe("stopped")
        expect(result.state.exists).toBe(false)
        expect(result.state.path).toBe(file)
        expect(result.state.backfill.status).toBe("idle")
        expect(await Bun.file(file).exists()).toBe(false)
      },
    })
  })

  test("surfaces current service and backfill state", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            memory: {
              hindsight: {
                enabled: true,
                mode: "embedded",
                extract: true,
                recall: true,
                backfill: true,
                workspace_scope: "worktree",
                context_max_items: 6,
                context_max_tokens: 1200,
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const now = Date.now()
        await MemoryHindsightState.save({
          version: 1,
          bank_id: MemoryHindsightBank.bankId(tmp.path),
          workspace_hash: MemoryHindsightBank.worktreeHash(tmp.path),
          workspace_scope: "worktree",
          updated_at: 0,
          backfill: {
            status: "failed",
            mode: "auto",
            started_at: now,
            updated_at: 0,
            completed_at: now,
            cursor: "mem_3",
            last_memory_id: "mem_3",
            last_document_id: "mem:abc",
            processed: 3,
            succeeded: 2,
            failed: 1,
            skipped: 0,
            batch_size: 25,
            operation_ids: ["op_1"],
            failures: [{ memory_id: "mem_3", document_id: "mem:abc", error: "timeout", at: now }],
          },
        })
        spyOn(MemoryHindsightService, "get").mockResolvedValue({
          status: "degraded",
          root: tmp.path,
          bank_id: MemoryHindsightBank.bankId(tmp.path),
          profile: `opencode-${MemoryHindsightBank.worktreeHash(tmp.path)}`,
          base_url: "http://127.0.0.1:40123",
          port: 40123,
          error: "timeout",
        })

        const result = await loadHindsightInspect()

        expect(result.service.status).toBe("degraded")
        expect(result.service.error).toBe("timeout")
        expect(result.state.exists).toBe(true)
        expect(result.state.backfill).toMatchObject({
          status: "failed",
          cursor: "mem_3",
          processed: 3,
          succeeded: 2,
          failed: 1,
          operation_ids: ["op_1"],
        })
      },
    })
  })

  test("exports the debug subcommand", () => {
    expect(HindsightCommand.command).toBe("hindsight")
  })
})
