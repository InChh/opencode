import z from "zod"
import { Tool } from "@/tool/tool"
import { Memory } from "../memory"
import { MemoryExtractor } from "../engine/extractor"

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
    // Extract recent messages for context
    const recentMessages = (ctx.messages ?? []).slice(-10).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }))

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
