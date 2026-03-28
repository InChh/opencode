import z from "zod"
import { Tool } from "@/tool/tool"
import { Memory } from "../memory"
import { MemoryExtractor } from "../engine/extractor"

function flat(raw: unknown[]) {
  return raw.flatMap((msg) => {
    if (!msg || typeof msg !== "object") return []

    const item = msg as Record<string, unknown>
    if (item.info && Array.isArray(item.parts)) {
      const role = (item.info as Record<string, unknown>).role
      if (typeof role !== "string") return []

      const content = item.parts
        .flatMap((part) => {
          if (!part || typeof part !== "object") return []
          const item = part as Record<string, unknown>
          if (item.type !== "text" || item.ignored || typeof item.text !== "string") return []
          return [item.text]
        })
        .join("\n")

      if (!content) return []
      return [{ role, content }]
    }

    if (typeof item.role !== "string" || item.content === undefined) return []
    return [
      {
        role: item.role,
        content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
      },
    ]
  })
}

export const MemoryRememberTool = Tool.define("memory_remember", {
  description: [
    "Save a memory about user preferences, coding patterns, project conventions, or tool choices.",
    "Use this when the user explicitly asks to remember something, or when you detect an important preference.",
    "The memory should be clear and self-contained — avoid vague references.",
  ].join(" "),
  parameters: z.object({
    content: z.string().describe("Clear, self-contained description of the preference or convention"),
    category: Memory.Category.describe("Category: style, pattern, tool, domain, workflow, correction, context"),
    tags: z.array(z.string()).optional().describe("Keywords for future recall"),
  }),
  async execute(args, ctx) {
    const recentMessages = flat((ctx.messages as unknown[]).slice(-10))

    const memory = await MemoryExtractor.rememberWithContext(ctx.sessionID, args.content, recentMessages, {
      category: args.category,
      tags: args.tags,
    })

    return {
      title: `Remembered: ${args.category}`,
      metadata: { memoryID: memory.id },
      output: [
        `Memory saved (${memory.id}):`,
        `  Category: ${memory.category}`,
        `  Content: ${memory.content}`,
        memory.tags.length > 0 ? `  Tags: ${memory.tags.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }
  },
})
