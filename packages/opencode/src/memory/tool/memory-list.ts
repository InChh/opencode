import z from "zod"
import { Tool } from "@/tool/tool"
import { Memory } from "../memory"

export const MemoryListTool = Tool.define("memory_list", {
  description: [
    "List saved memories with optional filtering by scope, category, or status.",
    "Use this when the user wants to see their memories.",
  ].join(" "),
  parameters: z.object({
    scope: Memory.Scope.optional().describe("Filter by scope: personal or team"),
    category: Memory.Category.optional().describe("Filter by category"),
    status: Memory.Status.optional().describe("Filter by status: pending or confirmed"),
  }),
  async execute(args) {
    const memories = await Memory.list({
      scope: args.scope,
      category: args.category,
      status: args.status,
    })

    if (memories.length === 0) {
      return {
        title: "No memories",
        metadata: { count: 0 },
        output: "No memories found matching the given filters.",
      }
    }

    const lines = memories
      .sort((a, b) => b.score - a.score)
      .map((m) => {
        const statusIcon = m.status === "pending" ? "⏳" : "✓"
        const scopeTag = m.scope === "team" ? " [team]" : ""
        const tags = m.tags.length > 0 ? ` (${m.tags.join(", ")})` : ""
        return `${statusIcon} ${m.id}: [${m.categories.join(",")}]${scopeTag} ${m.content}${tags}  (score: ${m.score.toFixed(1)}, uses: ${m.useCount})`
      })

    return {
      title: `${memories.length} memories`,
      metadata: { count: memories.length },
      output: [`Found ${memories.length} memories:`, "", ...lines].join("\n"),
    }
  },
})
