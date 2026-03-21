import { registerMemoryInjector } from "./inject"
import { registerAutoExtract } from "./auto-extract"
import { registerHitTracker } from "./hit-tracker"
import { registerOptimizerHook } from "./optimizer-hook"

/**
 * Register all memory-related hooks.
 *
 * Hook priority table:
 *   pre-llm:
 *     130 - memory-injector (after agents + rules injection)
 *
 *   post-tool:
 *     210 - memory-hit-tracker (after output truncation)
 *
 *   session-lifecycle:
 *     200 - memory-extract-compaction (compaction-time extraction)
 *     210 - memory-extract-recovery (startup recovery)
 *     220 - memory-optimizer (periodic maintenance)
 */
export function registerMemoryHooks(): void {
  registerMemoryInjector()
  registerAutoExtract()
  registerHitTracker()
  registerOptimizerHook()
}
