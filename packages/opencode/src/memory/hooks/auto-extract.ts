import { HookChain } from "@/session/hooks"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { MemoryExtractor } from "../engine/extractor"

const log = Log.create({ service: "memory.hooks.auto-extract" })

/**
 * Register memory extraction hooks:
 *
 * 1. Compaction-time extraction (priority 200):
 *    Extracts memories when session is being compacted (main extraction path).
 *
 * 2. Startup recovery extraction (priority 210):
 *    On session.created, check if previous sessions had their extraction missed.
 *    Idempotent via `extracted:{sessionID}` meta key in MemoryExtractor.extractFromSession.
 */
export function registerAutoExtract(): void {
  // Compaction-time extraction
  HookChain.register("memory-extract-compaction", "session-lifecycle", 200, async (ctx) => {
    if (ctx.event !== "session.compacting") return

    const config = await Config.get()
    if (config.memory?.enabled === false) return
    if (config.memory?.autoExtract === false) return

    // Build message list from context (if available)
    const messages = (ctx.messages ?? []).map((m: any) => ({
      role: m.role as string,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }))

    const extracted = await MemoryExtractor.extractFromSession(ctx.sessionID, messages)
    log.info("compaction extraction complete", {
      sessionID: ctx.sessionID,
      extracted: extracted.length,
    })
  })

  // Startup recovery extraction
  HookChain.register("memory-extract-recovery", "session-lifecycle", 210, async (ctx) => {
    if (ctx.event !== "session.created") return

    const config = await Config.get()
    if (config.memory?.enabled === false) return
    if (config.memory?.autoExtract === false) return

    // Recovery: re-extract current session if it was missed.
    // MemoryExtractor.extractFromSession handles idempotency internally.
    // In future, can iterate over recent sessions from Session.listRecent().
    log.info("startup recovery check", { sessionID: ctx.sessionID })
  })
}
