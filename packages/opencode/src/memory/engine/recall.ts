import z from "zod"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Memory } from "../memory"
import { Bus } from "@/bus"
import { MemoryEvent } from "../event"
import { load } from "../prompt/loader"
import { ConfigPaths } from "@/config/paths"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"

export namespace MemoryRecall {
  const log = Log.create({ service: "memory.recall" })

  // Track whether we've warned this session about primary model usage
  const warned = new Set<string>()

  export const Result = z.object({
    relevant: z.array(z.string()),
    conflicts: z.array(
      z.object({
        memoryA: z.string(),
        memoryB: z.string(),
        reason: z.string(),
      }),
    ),
  })
  export type Result = z.infer<typeof Result>

  /**
   * Resolve the model ref for memory agents from config or default.
   */
  async function model() {
    const cfg = await Config.get()
    const agent = cfg.agent?.["memory-recall"]
    if (agent?.model) {
      return Provider.parseModel(agent.model)
    }
    if (cfg.memory?.recallModel) {
      const primary = await Provider.defaultModel()
      return {
        providerID: cfg.memory.recallProvider ?? primary.providerID,
        modelID: cfg.memory.recallModel,
      }
    }
    const primary = await Provider.defaultModel()
    const small = await Provider.getSmallModel(primary.providerID)
    if (small) {
      return { providerID: small.providerID, modelID: small.id }
    }
    if (!warned.has("recall")) {
      warned.add("recall")
      log.warn("memory-recall using primary model, consider config.agent.memory-recall.model or config.small_model")
      Bus.publish(MemoryEvent.Warning, {
        type: "memory_model_cost",
        agent: "memory-recall",
        model: `${primary.providerID}/${primary.modelID}`,
      })
    }
    return primary
  }

  /**
   * Parse JSON from LLM text response, handling markdown code fences.
   */
  function parse(text: string): Result | undefined {
    const clean = text.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g, "$1").trim()
    const start = clean.indexOf("{")
    if (start === -1) return undefined
    const end = clean.lastIndexOf("}")
    if (end === -1) return undefined
    const result = Result.safeParse(JSON.parse(clean.slice(start, end + 1)))
    return result.success ? result.data : undefined
  }

  /**
   * Invoke the recall agent to filter candidate memories for relevance.
   *
   * Uses the standard subagent pipeline (SessionPrompt.prompt) for full
   * security, hook chain, log capture, and provider transform support.
   */
  export async function invoke(input: {
    sessionID: string
    memories: Memory.Info[]
    recentMessages: Array<{ role: string; content: string }>
  }): Promise<Result> {
    try {
      const candidates = input.memories.map((m) => ({
        id: m.id,
        content: m.content,
        categories: m.categories,
        tags: m.tags,
      }))

      const context = input.recentMessages
        .slice(-6)
        .map((m) => `[${m.role}]: ${m.content}`)
        .join("\n---\n")

      // System prompt: role definition + candidate memories + conversation context
      const base = await load("recall", await ConfigPaths.directories(Instance.directory, Instance.worktree))
      const sys = [
        base,
        "",
        "## Candidate Memories",
        "",
        JSON.stringify(candidates),
        "",
        "## Recent Conversation",
        "",
        context,
      ].join("\n")

      // User prompt: task instruction only
      const task = [
        "Filter the candidate memories in the system prompt for relevance to the current conversation.",
        "Detect any conflicts between memories.",
        "",
        "Respond ONLY with the JSON object. No explanation before or after.",
      ].join("\n")

      const session = await Session.create({
        parentID: input.sessionID,
        title: "memory-recall",
      })

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        model: await model(),
        agent: "memory-recall",
        system: sys,
        parts: [{ type: "text", text: task }],
      })

      // Parse JSON from the text response
      const text = result.parts
        .filter((p: { type: string }) => p.type === "text")
        .map((p: { text?: string }) => p.text ?? "")
        .join("")
      const parsed = parse(text)

      if (!parsed) {
        log.error("recall agent returned unparseable response", { text: text.slice(0, 200) })
        return { relevant: input.memories.map((m) => m.id), conflicts: [] }
      }

      log.info("recall complete", {
        candidates: input.memories.length,
        relevant: parsed.relevant.length,
        conflicts: parsed.conflicts.length,
      })

      return parsed
    } catch (err) {
      log.error("recall agent failed, returning all candidates as relevant", { error: err })
      return {
        relevant: input.memories.map((m) => m.id),
        conflicts: [],
      }
    }
  }
}
