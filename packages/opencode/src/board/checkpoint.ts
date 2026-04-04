import z from "zod"
import { Log } from "../util/log"
import { BoardTask } from "./task"
import { BoardArtifact } from "./artifact"
import { SharedBoard, BoardSignal } from "."
import { SessionMetadata } from "../session/session-metadata"
import { Config } from "../config/config"

export namespace Checkpoint {
  const log = Log.create({ service: "board.checkpoint" })

  export const Schema = z.object({
    goal: z.string(),
    task: z.string(),
    progress: z.array(z.object({ item: z.string(), done: z.boolean() })),
    decisions: z.array(z.string()).default([]),
    state: z.string().default(""),
    files: z.array(z.string()),
    session_chain: z.array(z.string()),
  })
  export type Schema = z.infer<typeof Schema>

  function chain(sessionID: string): string[] {
    const ids: string[] = [sessionID]
    let current = sessionID
    for (let i = 0; i < 100; i++) {
      const meta = SessionMetadata.get(current)
      const prev = meta?.prev_session as string | undefined
      if (!prev) break
      ids.push(prev)
      current = prev
    }
    return ids.reverse()
  }

  export async function generate(input: {
    sessionID: string
    swarmID: string
    taskID?: string
  }): Promise<{ content: string; id?: string }> {
    const start = Date.now()
    const snap = await SharedBoard.snapshot(input.swarmID)

    // Find current task
    const task = input.taskID
      ? snap.tasks.find((t) => t.id === input.taskID)
      : snap.tasks.find((t) => t.status === "in_progress")

    const goal = (await import("../session/swarm").then((m) => m.Swarm.load(input.swarmID)))?.goal ?? ""

    // Build progress from tasks
    const progress = snap.tasks.map((t) => ({
      item: `[${t.id}] ${t.subject}`,
      done: t.status === "completed",
    }))

    // Aggregate files from artifacts
    const files = [...new Set(snap.artifacts.flatMap((a) => a.files))]

    // Build session chain
    const sessions = chain(input.sessionID)

    const data: Schema = {
      goal,
      task: task ? `${task.id} ${task.subject}` : "none",
      progress,
      decisions: [],
      state: "",
      files,
      session_chain: sessions,
    }

    // LLM extraction for decisions and state
    const cfg = await Config.get()
    if (cfg.rotation?.checkpoint_llm !== false) {
      try {
        const extracted = await extract(input)
        if (extracted) {
          data.decisions = extracted.decisions
          data.state = extracted.state
        }
      } catch (err) {
        log.warn("llm extraction failed, using template-only", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Detect Conductor and add coordination block (US-007)
    let coord = ""
    const swarm = await import("../session/swarm").then((m) => m.Swarm.load(input.swarmID))
    if (swarm && swarm.conductor === input.sessionID) {
      coord = coordination(swarm, snap)
    }

    const content = render(data) + coord

    // Write as board artifact
    const artifact = await BoardArtifact.post({
      type: "checkpoint",
      task_id: task?.id ?? "none",
      swarm_id: input.swarmID,
      author: input.sessionID,
      content,
      files,
    })

    log.info("generated", {
      sessionID: input.sessionID,
      swarmID: input.swarmID,
      duration: Date.now() - start,
      hasLLM: data.decisions.length > 0,
    })

    return { content, id: artifact.id }
  }

  function render(data: Schema): string {
    const lines: string[] = [
      "# Checkpoint",
      "",
      `## Goal`,
      data.goal,
      "",
      `## Current Task`,
      data.task,
      "",
      `## Progress`,
      ...data.progress.map((p) => `- [${p.done ? "x" : " "}] ${p.item}`),
      "",
    ]
    if (data.decisions.length) {
      lines.push("## Key Decisions", ...data.decisions.map((d) => `- ${d}`), "")
    }
    if (data.state) {
      lines.push("## Working State", data.state, "")
    }
    if (data.files.length) {
      lines.push("## Files", ...data.files.map((f) => `- ${f}`), "")
    }
    lines.push("## Session Chain", data.session_chain.join(" → "), "")
    return lines.join("\n")
  }

  function coordination(swarm: import("../session/swarm").Swarm.Info, snap: SharedBoard.Snapshot): string {
    const lines: string[] = ["", "<coordination>", "", "## Worker Assignments"]
    for (const w of swarm.workers) {
      const task = snap.tasks.find((t) => t.id === w.task_id)
      lines.push(`- ${w.session_id} → ${task ? `[${task.id}] ${task.subject}` : w.task_id} (${w.status})`)
    }

    // Unresolved escalations
    const resolved = new Set<string>()
    for (const sig of snap.recentSignals) {
      if (sig.type === "done") resolved.add(sig.channel)
    }
    const escalations = snap.recentSignals.filter(
      (s) => (s.type === "blocked" || s.type === "conflict") && !resolved.has(s.channel),
    )
    if (escalations.length) {
      lines.push("", "## Unresolved Escalations")
      for (const e of escalations) {
        lines.push(`- [${e.type}] ${e.from}: ${JSON.stringify(e.payload).slice(0, 200)}`)
      }
    }

    lines.push(
      "",
      "## Overall Progress",
      `${snap.stats.completed}/${snap.stats.total} completed, ${snap.stats.failed} failed, ${snap.stats.running} running`,
      "",
      "</coordination>",
    )
    return lines.join("\n")
  }

  async function extract(input: {
    sessionID: string
    swarmID: string
  }): Promise<{ decisions: string[]; state: string } | undefined> {
    // Lazy imports to avoid circular deps
    const { Session } = await import("../session")
    const { MessageV2 } = await import("../session/message-v2")
    const { Agent } = await import("../agent/agent")
    const { Provider } = await import("../provider/provider")

    const msgs = await Session.messages({ sessionID: input.sessionID })
    if (!msgs.length) return undefined

    const agent = await Agent.get("compaction")
    const last = msgs.findLast((m) => m.info.role === "user")
    if (!last) return undefined

    const user = last.info as import("../session/message-v2").MessageV2.User
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(user.model.providerID, user.model.modelID)

    const prepared = MessageV2.toModelMessages(msgs, model, { stripMedia: true, stripSynthetic: true })

    const prompt = `Extract from this conversation:
1. KEY DECISIONS: List each significant decision made and its rationale (one per line, as a dash-prefixed list)
2. WORKING STATE: Describe the current state of work in 2-3 sentences

Format:
DECISIONS:
- decision 1
- decision 2

STATE:
description`

    // Use lightweight LLM call via AI SDK
    const { generateText } = await import("ai")
    const language = await Provider.getLanguage(model)
    const result = await generateText({
      model: language,
      messages: [...prepared, { role: "user", content: prompt }],
      abortSignal: AbortSignal.timeout(30_000),
    })

    const text = result.text
    const decisions: string[] = []
    let state = ""

    const lines = text.split("\n")
    let section = ""
    for (const line of lines) {
      if (line.includes("DECISIONS:")) {
        section = "decisions"
        continue
      }
      if (line.includes("STATE:")) {
        section = "state"
        continue
      }
      if (section === "decisions" && line.trim().startsWith("-")) {
        decisions.push(line.trim().slice(1).trim())
      }
      if (section === "state" && line.trim()) {
        state += (state ? " " : "") + line.trim()
      }
    }

    return { decisions, state }
  }
}
