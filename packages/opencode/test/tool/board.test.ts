import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { BoardTask } from "../../src/board/task"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Swarm } from "../../src/session/swarm"
import { BoardWriteTool } from "../../src/tool/board"

const ctx = {
  sessionID: "",
  messageID: "test-msg",
  callID: "test-call",
  agent: "conductor",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.board_write", () => {
  async function withInstance(fn: () => Promise<void>) {
    await using tmp = await tmpdir({ git: true, config: {} })
    await Instance.provide({
      directory: tmp.path,
      fn,
    })
  }

  async function setup() {
    const swarmID = `SW-test-${crypto.randomUUID()}`
    const ses = await Session.create({ title: "Swarm conductor" })
    const now = Date.now()
    await Swarm.save({
      id: swarmID,
      goal: "Test swarm",
      conductor: ses.id,
      workers: [],
      config: {
        max_workers: 4,
        auto_escalate: true,
        verify_on_complete: true,
        wait_timeout_seconds: 600,
      },
      status: "active",
      stage: "planning",
      reason: null,
      resume: { stage: null },
      visibility: { archived_at: null },
      time: { created: now, updated: now },
    })
    return { sessionID: ses.id, swarmID }
  }

  test("accepts legacy top-level create_task fields", async () => {
    await withInstance(async () => {
      const tool = await BoardWriteTool.init()
      const { sessionID, swarmID } = await setup()
      const result = await tool.execute(
        {
          operation: "create_task",
          swarm_id: swarmID,
          title: "Study source repo",
          description: "Inspect the source repository for strong patterns.",
          owner: "atlas",
        },
        { ...ctx, sessionID },
      )

      expect(result.title).toContain("Created task")
      const list = await BoardTask.list(swarmID)
      expect(list).toHaveLength(1)
      expect(list[0]?.subject).toBe("Study source repo")
      expect(list[0]?.assignee).toBe("atlas")
      expect(list[0]?.status).toBe("ready")
    })
  })

  test("maps data.title and data.owner aliases for create_task", async () => {
    await withInstance(async () => {
      const tool = await BoardWriteTool.init()
      const { sessionID, swarmID } = await setup()
      const result = await tool.execute(
        {
          operation: "create_task",
          swarm_id: swarmID,
          data: {
            title: "Map target gaps",
            description: "Inspect the target repository for safe integration points.",
            owner: "omo-explore",
            blockedBy: ["BT-prev"],
          },
        },
        { ...ctx, sessionID },
      )

      expect(result.title).toContain("Created task")
      const list = await BoardTask.list(swarmID)
      expect(list).toHaveLength(1)
      expect(list[0]?.subject).toBe("Map target gaps")
      expect(list[0]?.assignee).toBe("omo-explore")
      expect(list[0]?.status).toBe("pending")
    })
  })
})
