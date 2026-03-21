import z from "zod"
import { generateObject, type ModelMessage } from "ai"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Memory } from "../memory"
import { load } from "../prompt/loader"
import { ConfigPaths } from "@/config/paths"
import { Instance } from "@/project/instance"

export namespace MemoryRecall {
  const log = Log.create({ service: "memory.recall" })

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
   * Invoke the recall agent to filter candidate memories for relevance.
   *
   * Uses a lightweight model (configurable via config.memory.recallModel/recallProvider)
   * at temperature 0 for deterministic filtering.
   */
  export async function invoke(input: {
    memories: Memory.Info[]
    recentMessages: Array<{ role: string; content: string }>
  }): Promise<Result> {
    const cfg = await Config.get()

    // Resolve model
    const recallProvider = cfg.memory?.recallProvider
    const recallModel = cfg.memory?.recallModel
    let modelRef: { providerID: string; modelID: string }

    if (recallProvider && recallModel) {
      modelRef = { providerID: recallProvider, modelID: recallModel }
    } else {
      // Fall back to default model
      modelRef = await Provider.defaultModel()
    }

    const model = await Provider.getModel(modelRef.providerID, modelRef.modelID)
    const language = await Provider.getLanguage(model)

    // Build candidate list
    const candidateList = input.memories.map((m) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      tags: m.tags,
    }))

    // Build recent conversation context
    const conversationContext = input.recentMessages
      .slice(-6)
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n---\n")

    const userMessage = [
      "## Candidate Memories",
      "",
      JSON.stringify(candidateList, null, 2),
      "",
      "## Recent Conversation",
      "",
      conversationContext,
    ].join("\n")

    const prompt = await load("recall", await ConfigPaths.directories(Instance.directory, Instance.worktree))

    try {
      const result = await generateObject({
        temperature: 0,
        messages: [
          {
            role: "system",
            content: prompt,
          } satisfies ModelMessage,
          {
            role: "user",
            content: userMessage,
          } satisfies ModelMessage,
        ],
        model: language,
        schema: Result,
      })

      log.info("recall complete", {
        candidates: input.memories.length,
        relevant: result.object.relevant.length,
        conflicts: result.object.conflicts.length,
      })

      return result.object
    } catch (err) {
      log.error("recall agent failed, returning all candidates as relevant", { error: err })
      // Graceful fallback: return all memories as relevant, no conflicts
      return {
        relevant: input.memories.map((m) => m.id),
        conflicts: [],
      }
    }
  }
}
