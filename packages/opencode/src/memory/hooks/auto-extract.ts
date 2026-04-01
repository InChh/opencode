import { HookChain } from "@/session/hooks"
import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { MemoryExtractor } from "../engine/extractor"
import { Session } from "@/session"
import { Memory } from "../memory"

const log = Log.create({ service: "memory.hooks.auto-extract" })

const DEFAULT_INTERVAL = 20
const MIN_MESSAGES = 6

/**
 * Unified idempotency key for a session.
 * All extraction paths (compaction, periodic, recovery) mark the same key,
 * so a session is never extracted twice.
 */
function extractedKey(sessionID: string): string {
  return `extracted:${sessionID}`
}

/**
 * Check whether a session has already been extracted by any path.
 */
async function alreadyExtracted(sessionID: string): Promise<boolean> {
  return !!(await Memory.getMeta(extractedKey(sessionID)))
}

/**
 * Mark a session as extracted (idempotent across all paths).
 */
async function markExtracted(sessionID: string): Promise<void> {
  await Memory.setMeta(extractedKey(sessionID), Date.now())
}

/**
 * Convert MessageV2.WithParts[] to flat {role, content}[] for extraction.
 */
function flatten(raw: unknown[]): Array<{ role: string; content: string }> {
  return raw
    .map((m) => {
      if (!m || typeof m !== "object") return undefined
      const msg = m as Record<string, unknown>
      if (msg.info && msg.parts) {
        const parts = msg.parts as Array<Record<string, unknown>>
        const text = parts
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text as string)
          .join("\n")
        if (!text) return undefined
        return { role: (msg.info as Record<string, unknown>).role as string, content: text }
      }
      if (msg.role && msg.content) {
        return {
          role: msg.role as string,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        }
      }
      return undefined
    })
    .filter((m): m is { role: string; content: string } => !!m)
}

/**
 * Load messages for a session and run extraction.
 */
async function extract(sessionID: string): Promise<number> {
  const config = await Config.get()
  const min = config.memory?.extract_min_messages ?? MIN_MESSAGES
  const msgs = await Session.messages({ sessionID })
  const messages = flatten(msgs)
  if (messages.length < min) return 0
  const result = await MemoryExtractor.extractFromSession(sessionID, messages)
  return result.length
}

// Per-session step counter for periodic extraction
const steps = new Map<string, number>()

/**
 * Register memory extraction hooks (compaction + periodic + cleanup).
 *
 * 1. Compaction-time (priority 200) — before context is discarded.
 * 2. Periodic (priority 201)        — every N steps within a session.
 * 3. Cleanup (priority 205)         — clean up step counter on session end.
 *
 * All paths share a unified idempotency key `extracted:{sessionID}` so a session
 * is never extracted twice regardless of which path triggered first.
 *
 * NOTE: Startup recovery is NOT a hook — it runs in InstanceBootstrap via
 * `recoveryExtract()` so it fires on app startup, not on session.created.
 */
export function registerAutoExtract(): void {
  // --- 1. Compaction-time extraction ---
  // NOTE: compaction extraction ignores the unified extracted key because its
  // purpose is to capture content BEFORE it is discarded. New messages may have
  // been added since the last periodic extraction.
  HookChain.register("memory-extract-compaction", "session-lifecycle", 200, async (ctx) => {
    if (ctx.event !== "session.compacting") return

    const config = await Config.get()
    if (config.memory?.enabled === false) return
    if (config.memory?.autoExtract === false) return

    const raw = ctx.data?.messages ?? []
    const messages = flatten(raw)

    const result = await MemoryExtractor.extractFromSession(ctx.sessionID, messages)
    await markExtracted(ctx.sessionID)
    log.info("compaction extraction complete", {
      sessionID: ctx.sessionID,
      changed: result.length,
    })
  })

  // --- 2. Periodic extraction on step.finished ---
  HookChain.register("memory-extract-periodic", "session-lifecycle", 201, async (ctx) => {
    if (ctx.event !== "step.finished") return

    const config = await Config.get()
    if (config.memory?.enabled === false) return
    if (config.memory?.autoExtract === false) return

    const interval = config.memory?.extract_interval ?? DEFAULT_INTERVAL
    const count = (steps.get(ctx.sessionID) ?? 0) + 1
    steps.set(ctx.sessionID, count)

    if (count % interval !== 0) return

    // Smart skip: check if there are enough user messages since last extraction
    const msgs = await Session.messages({ sessionID: ctx.sessionID })
    const lastExtractKey = `periodic:${ctx.sessionID}`
    const lastExtract = await Memory.getMeta(lastExtractKey)
    const lastExtractStep = lastExtract ? Number(lastExtract) : 0
    const userMsgsSince = msgs.filter((m) => m.info.role === "user" && m.info.time.created > lastExtractStep).length
    if (userMsgsSince < 2) {
      log.info("extraction skipped", {
        reason: "insufficient user messages",
        sessionID: ctx.sessionID,
        userMsgCount: userMsgsSince,
      })
      return
    }

    // Periodic re-extracts the current session even if previously extracted,
    // because new messages have been added since the last extraction.
    // Use epoch-scoped key to avoid repeating the same epoch.
    const epoch = Math.floor(count / interval)
    const key = `periodic:${ctx.sessionID}:${epoch}`
    if (await Memory.getMeta(key)) return

    log.info("periodic extraction triggered", {
      sessionID: ctx.sessionID,
      step: count,
      epoch,
    })

    try {
      const changed = await extract(ctx.sessionID)
      log.info("periodic extraction complete", { sessionID: ctx.sessionID, changed })
      await Memory.setMeta(lastExtractKey, Date.now())
    } catch (err) {
      log.error("periodic extraction failed", { sessionID: ctx.sessionID, error: err })
    }
    await Memory.setMeta(key, Date.now())
    // Also mark the unified key so recovery won't re-extract this session
    await markExtracted(ctx.sessionID)
  })

  // --- 3. Cleanup step counter when session ends ---
  HookChain.register("memory-extract-cleanup", "session-lifecycle", 205, async (ctx) => {
    if (ctx.event !== "session.deleted") return
    steps.delete(ctx.sessionID)
  })
}

/**
 * Startup recovery: scan ALL historical sessions and auto-extract any that
 * have never been extracted. Runs asynchronously on app startup (called from
 * InstanceBootstrap), not tied to any session lifecycle event.
 *
 * - Iterates sessions created within recovery_max_age_days (default 7)
 * - Skips sessions already marked with `extracted:{sessionID}`
 * - Skips sessions with fewer than MIN_MESSAGES messages
 * - On failure, marks the session to avoid retrying every startup
 * - Processes in batches of 5 to avoid overwhelming the system
 * - Fully idempotent: safe to call multiple times
 */
export async function recoveryExtract(): Promise<void> {
  const config = await Config.get()
  if (config.memory?.enabled === false) return
  if (config.memory?.autoExtract === false) return

  log.info("startup recovery: scanning all sessions")

  const maxAge = config.memory?.recovery_max_age_days ?? 7
  const cutoff = Date.now() - maxAge * 24 * 60 * 60 * 1000
  const all = [...Session.list()].filter((s) => s.time.created >= cutoff)
  let recovered = 0
  let skipped = 0

  const batchSize = 5
  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize)
    await Promise.all(
      batch.map(async (session) => {
        if (await alreadyExtracted(session.id)) {
          skipped++
          return
        }
        try {
          const changed = await extract(session.id)
          await markExtracted(session.id)
          if (changed > 0) recovered += changed
        } catch (err) {
          log.warn("recovery extraction failed for session", { sessionID: session.id, error: err })
          // Mark to avoid retrying a broken session every startup
          await markExtracted(session.id)
        }
      }),
    )
  }

  log.info("startup recovery complete", {
    total: all.length,
    skipped,
    recovered,
    extracted: all.length - skipped,
  })
}
