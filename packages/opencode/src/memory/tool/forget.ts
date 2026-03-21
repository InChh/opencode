import z from "zod"
import { Tool } from "@/tool/tool"
import { Memory } from "../memory"
import { Bus } from "@/bus"
import { MemoryEvent } from "../event"

export const MemoryForgetTool = Tool.define("memory_forget", {
  description: [
    "Delete a memory by its ID or by searching for matching content.",
    "Use this when the user wants to remove a previously saved memory.",
  ].join(" "),
  parameters: z.object({
    id: z.string().optional().describe("Memory ID to delete (e.g., mem_xxx)"),
    search: z.string().optional().describe("Search text to find and delete matching memories"),
  }),
  async execute(args, ctx) {
    if (args.id) {
      const memory = await Memory.get(args.id)
      if (!memory) {
        return {
          title: "Memory not found",
          metadata: {},
          output: `No memory found with ID: ${args.id}`,
        }
      }
      await Memory.remove(args.id)
      Memory.markDirty(ctx.sessionID)
      await Bus.publish(MemoryEvent.Removed, { id: args.id })
      return {
        title: `Forgot: ${memory.category}`,
        metadata: { memoryID: args.id },
        output: `Deleted memory (${args.id}): ${memory.content}`,
      }
    }

    if (args.search) {
      const all = await Memory.list()
      const searchLower = args.search.toLowerCase()
      const matches = all.filter(
        (m) =>
          m.content.toLowerCase().includes(searchLower) ||
          m.tags.some((t) => t.toLowerCase().includes(searchLower)),
      )

      if (matches.length === 0) {
        return {
          title: "No matches",
          metadata: {},
          output: `No memories found matching: "${args.search}"`,
        }
      }

      if (matches.length === 1) {
        const match = matches[0]
        await Memory.remove(match.id)
        Memory.markDirty(ctx.sessionID)
        await Bus.publish(MemoryEvent.Removed, { id: match.id })
        return {
          title: `Forgot: ${match.category}`,
          metadata: { memoryID: match.id },
          output: `Deleted memory (${match.id}): ${match.content}`,
        }
      }

      // Multiple matches — list them for user to choose
      const list = matches
        .map((m) => `  ${m.id}: [${m.category}] ${m.content}`)
        .join("\n")
      return {
        title: `Found ${matches.length} matches`,
        metadata: { matchCount: matches.length },
        output: [
          `Found ${matches.length} memories matching "${args.search}":`,
          list,
          "",
          "Please specify the memory ID to delete.",
        ].join("\n"),
      }
    }

    return {
      title: "Missing input",
      metadata: {},
      output: "Please provide either an ID or search text to find memories to delete.",
    }
  },
})
