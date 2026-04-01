import type { MessageV2 } from "./message-v2"
import { Config } from "@/config/config"
import { Log } from "@/util/log"

const log = Log.create({ service: "prune-heuristic" })

const DEFAULTS: Record<string, number> = {
  read: 0.8,
  grep: 0.5,
  glob: 0.4,
  bash: 0.3,
  edit: 0.7,
  write: 0.7,
  skill: 1.0,
  task: 0.6,
  webfetch: 0.4,
  websearch: 0.4,
}

/**
 * Extract up to N significant tokens from tool output for reference checking.
 * Significant tokens = file paths, variable names, identifiers.
 */
function tokens(output: string, limit = 5): string[] {
  const result: string[] = []
  // Match file paths, identifiers, and quoted strings
  const patterns = [
    /(?:\/[\w./-]+)+/g, // file paths
    /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g, // CamelCase identifiers
    /\b[a-z_]\w{3,}\b/g, // snake_case or regular identifiers
  ]
  for (const pat of patterns) {
    for (const m of output.matchAll(pat)) {
      if (result.length >= limit) return result
      if (!result.includes(m[0])) result.push(m[0])
    }
  }
  return result
}

/**
 * Check if the next assistant message references any tokens from the tool output.
 */
function referenced(output: string, next: string | undefined): boolean {
  if (!next) return false
  const toks = tokens(output)
  return toks.some((t) => next.includes(t))
}

/**
 * Infer retain for a tool part that has retain === undefined.
 * Returns true (keep) or false (prune).
 */
export async function infer(part: MessageV2.ToolPart, next: MessageV2.WithParts | undefined): Promise<boolean> {
  const config = await Config.get()
  const weights: Record<string, number> = {
    ...DEFAULTS,
    ...(config.compaction?.tool_weights ?? {}),
  }

  const weight = weights[part.tool] ?? 0.3
  if (part.state.status !== "completed") return false

  const nextText = next?.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")

  const ref = referenced(part.state.output, nextText)

  const keep = weight > 0.5 || ref
  log.info("inferred", { tool: part.tool, weight, ref, keep })
  return keep
}
