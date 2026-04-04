import { Log } from "../util/log"
import { Token } from "../util/token"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { SessionMetadata } from "./session-metadata"
import { Checkpoint } from "../board/checkpoint"
import { SharedBoard } from "../board"
import { HookChain } from "./hooks"

// Lazy imports to avoid circular dependency at module load time.
let _Session: typeof import("./index").Session | undefined
let _SessionPrompt: typeof import("./prompt").SessionPrompt | undefined
let _Swarm: typeof import("./swarm").Swarm | undefined

async function getSession() {
  if (!_Session) _Session = (await import("./index")).Session
  return _Session
}
async function getPrompt() {
  if (!_SessionPrompt) _SessionPrompt = (await import("./prompt")).SessionPrompt
  return _SessionPrompt
}
async function getSwarm() {
  if (!_Swarm) _Swarm = (await import("./swarm")).Swarm
  return _Swarm
}

export namespace SessionRotation {
  const log = Log.create({ service: "session.rotation" })

  // --- US-008: Bootstrap prompt generation ---

  export async function bootstrap(input: { checkpoint: string; swarmID: string; taskID?: string }): Promise<string> {
    const cfg = await Config.get()
    const max = cfg.rotation?.max_bootstrap_tokens ?? 6000

    // Build board state block
    const snap = await SharedBoard.snapshot(input.swarmID)
    const task = input.taskID
      ? snap.tasks.find((t) => t.id === input.taskID)
      : snap.tasks.find((t) => t.status === "in_progress")
    const signals = snap.recentSignals.slice(0, 5)
    const board = [
      `Tasks: ${snap.stats.completed}/${snap.stats.total} completed, ${snap.stats.running} running, ${snap.stats.failed} failed`,
      task ? `Current: [${task.id}] ${task.subject} (${task.status})` : "",
      signals.length
        ? `Recent signals:\n${signals.map((s) => `  [${s.type}] ${s.from}: ${JSON.stringify(s.payload).slice(0, 100)}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")

    // Build memory block
    let memories = ""
    try {
      const { Memory } = await import("../memory/memory")
      const all = await Memory.list({ scope: "personal" })
      const items = all.slice(0, 10).map((m) => `- ${m.content}`)
      memories = items.join("\n")
    } catch {
      // memory system may not be available
    }

    // Assemble blocks
    const blocks = [
      `<checkpoint>\n${input.checkpoint}\n</checkpoint>`,
      `<board_state>\n${board}\n</board_state>`,
      memories ? `<memories>\n${memories}\n</memories>` : "",
    ].filter(Boolean)

    // Truncate proportionally if over budget
    const total = Token.estimate(blocks.join("\n"))
    if (total > max) {
      const ratio = max / total
      return blocks
        .map((b) => {
          const len = Math.floor(b.length * ratio)
          return b.length > len ? b.slice(0, len) + "\n... [truncated]" : b
        })
        .join("\n\n")
    }

    return blocks.join("\n\n")
  }

  // --- US-009: Core rotate flow ---

  export async function rotate(input: {
    sessionID: string
    swarmID: string
    trigger: "overflow" | "boundary" | "manual"
  }): Promise<import("./index").Session.Info | undefined> {
    const Session = await getSession()
    const SessionPrompt = await getPrompt()
    const Swarm = await getSwarm()

    const meta = SessionMetadata.get(input.sessionID)
    const seq = ((meta?.rotation_seq as number) ?? -1) + 1

    log.info("starting", {
      sessionID: input.sessionID,
      swarmID: input.swarmID,
      trigger: input.trigger,
      seq,
    })

    Bus.publish(Session.Event.RotationStarted, {
      sessionID: input.sessionID,
      swarmID: input.swarmID,
      trigger: input.trigger,
      seq,
    })

    try {
      // Step 1: Memory extraction (trigger compacting hooks)
      log.info("extracting memory", { sessionID: input.sessionID })
      await HookChain.execute("session-lifecycle", {
        sessionID: input.sessionID,
        event: "session.compacting",
        data: {},
      }).catch((err) => {
        log.warn("memory extraction hook failed", { error: err instanceof Error ? err.message : String(err) })
      })

      // Step 2: Generate checkpoint
      log.info("generating checkpoint", { sessionID: input.sessionID })
      const start = Date.now()
      const checkpoint = await Checkpoint.generate({
        sessionID: input.sessionID,
        swarmID: input.swarmID,
        taskID: meta?.task_id as string | undefined,
      })
      log.info("checkpoint generated", { duration: Date.now() - start })

      // Step 3: Archive old session
      log.info("archiving", { sessionID: input.sessionID })
      await Session.archive(input.sessionID)

      // Step 4: Create new session with same permissions
      const old = await Session.get(input.sessionID)
      const fresh = await Session.create({
        parentID: old.parentID,
        title: old.title,
        permission: old.permission,
      })

      // Step 5: Set metadata on new session
      SessionMetadata.set(fresh.id, "prev_session", input.sessionID)
      SessionMetadata.set(fresh.id, "rotation_seq", seq)
      if (meta) {
        for (const key of ["swarm_id", "task_id", "discussion_channel"] as const) {
          if (meta[key] !== undefined) SessionMetadata.set(fresh.id, key, meta[key])
        }
      }

      // Step 6: Bootstrap prompt
      log.info("injecting bootstrap", { sessionID: fresh.id })
      const prompt = await bootstrap({
        checkpoint: checkpoint.content,
        swarmID: input.swarmID,
        taskID: meta?.task_id as string | undefined,
      })
      const tokens = Token.estimate(prompt)

      // Determine agent based on role
      const swarm = await Swarm.load(input.swarmID)
      const agent = swarm && swarm.conductor === input.sessionID ? "conductor" : undefined

      await SessionPrompt.prompt({
        sessionID: fresh.id,
        ...(agent ? { agent } : {}),
        parts: [{ type: "text", text: `[Session Rotation — continuing from archived session]\n\n${prompt}` }],
      })

      // Step 7: Replace session reference in swarm
      await Swarm.replaceWorkerSession(input.swarmID, input.sessionID, fresh.id)

      Bus.publish(Session.Event.RotationCompleted, {
        oldSessionID: input.sessionID,
        newSessionID: fresh.id,
        checkpointID: checkpoint.id,
        tokens,
      })

      log.info("completed", {
        oldSessionID: input.sessionID,
        newSessionID: fresh.id,
        tokens,
        trigger: input.trigger,
      })

      return fresh
    } catch (err) {
      log.error("failed", {
        sessionID: input.sessionID,
        error: err instanceof Error ? err.message : String(err),
        step: "rotate",
      })
      return undefined
    }
  }

  // --- US-010: shouldRotate decision function ---

  export async function shouldRotate(input: { sessionID: string }): Promise<boolean> {
    const cfg = await Config.get()
    if (cfg.rotation?.enabled === false) return false

    const meta = SessionMetadata.get(input.sessionID)
    if (!meta?.swarm_id) return false

    // Count summary messages (compaction markers)
    const Session = await getSession()
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let summaries = 0
    for (const msg of msgs) {
      if (msg.info.role === "assistant" && (msg.info as any).summary === true) summaries++
    }

    if (summaries === 0) return false

    // Check if Conductor
    const Swarm = await getSwarm()
    const swarm = await Swarm.load(meta.swarm_id as string)
    if (swarm && swarm.conductor === input.sessionID) {
      // Conductor logic
      if (cfg.rotation?.conductor_defer !== false) {
        const snap = await SharedBoard.snapshot(meta.swarm_id as string)
        if (snap.stats.running > 0 && summaries < 2) return false
      }
      return true
    }

    // Worker: rotate after first compaction
    return true
  }
}
