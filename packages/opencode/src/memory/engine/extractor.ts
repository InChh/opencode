import z from "zod"
import { generateObject, type ModelMessage } from "ai"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Memory } from "../memory"
import { Bus } from "@/bus"
import { MemoryEvent } from "../event"
import { load, sections } from "../prompt/loader"
import { render } from "../prompt/template"
import { ConfigPaths } from "@/config/paths"
import { Instance } from "@/project/instance"

export namespace MemoryExtractor {
  const log = Log.create({ service: "memory.extractor" })

  // --- LLM extraction result schema ---

  export const ExtractedItem = z.object({
    content: z.string(),
    category: Memory.Category,
    tags: z.array(z.string()).default([]),
    citations: z.array(z.string()).default([]),
  })
  export type ExtractedItem = z.infer<typeof ExtractedItem>

  /**
   * /remember command handler: extract memory with full conversation context.
   *
   * Takes the user's input and recent messages, builds a context snapshot,
   * and stores the memory with full traceability.
   *
   * NOTE: LLM-based disambiguation is not yet implemented.
   * For now, stores the user's input directly with context snapshot.
   * When LLM integration is ready, replace with llmExtract() call.
   */
  export async function rememberWithContext(
    sessionID: string,
    userInput: string,
    recentMessages: Array<{ role: string; content: string }>,
    options?: {
      llmLogID?: string
      category?: Memory.Category
      tags?: string[]
    },
  ): Promise<Memory.Info> {
    // Build context snapshot from recent messages
    const contextWindow = recentMessages.slice(-10)
    const contextSnapshot = contextWindow.map((m) => `[${m.role}]: ${m.content}`).join("\n---\n")

    // NOTE: In the full implementation, use LLM to disambiguate userInput
    // using the context. For now, store userInput directly.
    const content = userInput
    const category = options?.category ?? "context"
    const tags = options?.tags ?? []

    const memory = await Memory.create({
      content,
      category,
      scope: "personal",
      status: "confirmed",
      tags,
      source: {
        sessionID,
        llmLogID: options?.llmLogID,
        method: "manual",
        contextSnapshot,
      },
    })

    Memory.markDirty(sessionID)
    await Bus.publish(MemoryEvent.Created, { info: memory })

    log.info("remember with context", {
      id: memory.id,
      sessionID,
      contentLength: content.length,
      contextMessages: contextWindow.length,
    })

    return memory
  }

  /**
   * Extract memories from a session's conversation history.
   *
   * Called during compaction or startup recovery.
   * Analyzes the full conversation to find persistent preferences,
   * patterns, and knowledge worth remembering.
   *
   * Uses LLM (generateObject) to identify extractable knowledge.
   * Idempotent via `extracted:{sessionID}` meta key.
   */
  export async function extractFromSession(
    sessionID: string,
    messages?: Array<{ role: string; content: string }>,
  ): Promise<Memory.Info[]> {
    // Check idempotency
    const metaKey = `extracted:${sessionID}`
    const alreadyExtracted = await Memory.getMeta(metaKey)
    if (alreadyExtracted) {
      log.info("session already extracted, skip", { sessionID })
      return []
    }

    if (!messages || messages.length === 0) {
      log.info("no messages to extract from", { sessionID })
      await Memory.setMeta(metaKey, Date.now())
      return []
    }

    // Build context snapshot
    const contextWindow = messages.slice(-20)
    const contextSnapshot = contextWindow.map((m) => `[${m.role}]: ${m.content}`).join("\n---\n")

    try {
      const cfg = await Config.get()
      const modelRef =
        cfg.memory?.recallProvider && cfg.memory?.recallModel
          ? { providerID: cfg.memory.recallProvider, modelID: cfg.memory.recallModel }
          : await Provider.defaultModel()

      const model = await Provider.getModel(modelRef.providerID, modelRef.modelID)
      const language = await Provider.getLanguage(model)

      const tpl = await load("extract", await ConfigPaths.directories(Instance.directory, Instance.worktree))
      const parts = sections(tpl)

      const prompt = buildAutoExtractPrompt(contextWindow, parts.analysis)

      const result = await generateObject({
        temperature: 0,
        messages: [
          {
            role: "system",
            content: parts.system,
          } satisfies ModelMessage,
          {
            role: "user",
            content: prompt,
          } satisfies ModelMessage,
        ],
        model: language,
        schema: z.object({
          items: z.array(ExtractedItem),
        }),
      })

      const extracted = result.object.items
      if (extracted.length === 0) {
        log.info("no memories worth extracting", { sessionID })
        await Memory.setMeta(metaKey, Date.now())
        return []
      }

      // Deduplicate against existing memories
      const existing = await Memory.list()
      const existingContents = new Set(existing.map((m) => m.content.toLowerCase()))

      const created: Memory.Info[] = []
      for (const item of extracted) {
        if (existingContents.has(item.content.toLowerCase())) continue

        const memory = await Memory.create({
          content: item.content,
          category: item.category,
          scope: "personal",
          status: "pending",
          tags: item.tags,
          citations: item.citations,
          source: {
            sessionID,
            method: "auto",
            contextSnapshot,
          },
        })
        created.push(memory)
        await Bus.publish(MemoryEvent.Created, { info: memory })
      }

      log.info("extracted memories from session", {
        sessionID,
        extracted: extracted.length,
        created: created.length,
        deduplicated: extracted.length - created.length,
      })

      // Mark as extracted (idempotency guard)
      await Memory.setMeta(metaKey, Date.now())
      return created
    } catch (err) {
      log.error("LLM extraction failed, marking as extracted to prevent retry storm", { sessionID, error: err })
      // Mark as extracted even on failure to prevent infinite retry
      await Memory.setMeta(metaKey, Date.now())
      return []
    }
  }

  /**
   * Build the LLM extraction prompt for /remember disambiguation.
   * Exported for testing and future LLM integration.
   */
  export function buildRememberPrompt(userInput: string, contextSnapshot: string): string {
    return [
      `The user said: "${userInput}"`,
      "",
      "Based on the conversation context below, extract a clear, self-contained memory",
      "that can be understood without the original conversation.",
      "",
      "Requirements:",
      '- Content must be self-contained, no pronouns like "this" or "that"',
      "- Include specific technical details (framework names, config values, code patterns)",
      "- Output JSON: { content, category, tags, citations }",
      "",
      "Context:",
      contextSnapshot,
    ].join("\n")
  }

  /**
   * Build the LLM extraction prompt for auto-extract.
   * Exported for testing and future LLM integration.
   */
  export function buildAutoExtractPrompt(messages: Array<{ role: string; content: string }>, tpl?: string): string {
    const formattedMessages = messages
      .slice(-20)
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n---\n")

    if (tpl) {
      return render(tpl, { CONVERSATION: formattedMessages })
    }

    return [
      "Analyze the following development conversation and extract persistent preferences,",
      "code patterns, tool choices, and project conventions worth remembering long-term.",
      "",
      "Distinguish between:",
      '- Persistent preferences ("our project uses Hono", "no semicolons") → EXTRACT',
      '- One-time instructions ("don\'t use console.log for this debug") → DO NOT extract',
      '- Project conventions ("API response format: { code, data, message }") → EXTRACT',
      '- Temporary context ("help me look at this bug") → DO NOT extract',
      "",
      "Conversation:",
      formattedMessages,
      "",
      "If nothing is worth extracting, return an empty array.",
      "For each extracted item, output JSON:",
      '[{ "content": "...", "category": "...", "tags": [...], "citations": [...] }]',
    ].join("\n")
  }
}
