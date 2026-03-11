import { Log } from "../../util/log"
import { HookChain } from "./index"

export namespace ErrorRecoveryHooks {
  const log = Log.create({ service: "hooks.error-recovery" })

  // --- Edit error recovery (PostToolChain, priority 100) ---
  // Detects edit tool failures and injects recovery guidance

  const EDIT_ERROR_PATTERNS = [
    {
      match: "oldString not found",
      message:
        "RECOVERY: The oldString was not found in the file. Re-read the file to get the exact current content, then retry with the correct oldString that matches exactly (including whitespace and indentation).",
    },
    {
      match: "Found multiple matches",
      message:
        "RECOVERY: The oldString matched multiple locations. Provide more surrounding context lines in oldString to uniquely identify the correct match.",
    },
    {
      match: "oldString and newString must be different",
      message:
        "RECOVERY: oldString and newString are identical. Ensure newString contains the actual changes you want to make.",
    },
  ]

  function registerEditErrorRecovery(): void {
    HookChain.register("edit-error-recovery", "post-tool", 100, async (ctx) => {
      if (ctx.toolName !== "edit") return
      const output = ctx.result.output
      for (const pattern of EDIT_ERROR_PATTERNS) {
        if (output.includes(pattern.match)) {
          ctx.result.output = output + "\n\n" + pattern.message
          log.info("edit error recovery injected", { pattern: pattern.match, sessionID: ctx.sessionID })
          return
        }
      }
    })
  }

  // --- Context window limit recovery (SessionLifecycleChain, priority 10) ---
  // On context_window_exceeded error, signals compaction before retry

  function registerContextWindowLimitRecovery(): void {
    HookChain.register("context-window-limit-recovery", "session-lifecycle", 10, async (ctx) => {
      if (ctx.event !== "session.error") return
      const errorData = ctx.data as { error?: { name?: string; data?: { message?: string } } } | undefined
      const errorName = errorData?.error?.name
      const errorMessage = errorData?.error?.data?.message ?? ""
      if (errorName === "APIError" && errorMessage.includes("context_window_exceeded")) {
        ctx.data = {
          ...ctx.data,
          recovery: "compact",
          message: "Context window exceeded. Triggering compaction before retry.",
        }
        log.info("context window limit recovery triggered", { sessionID: ctx.sessionID })
      }
    })
  }

  // --- Delegate task retry (PostToolChain, priority 200) ---
  // On delegate_task failure, detects structured error patterns and injects specific retry guidance

  interface DelegateTaskErrorPattern {
    pattern: string
    errorType: string
    fixHint: string
  }

  const DELEGATE_TASK_ERROR_PATTERNS: DelegateTaskErrorPattern[] = [
    {
      pattern: "run_in_background",
      errorType: "missing_run_in_background",
      fixHint: "Add run_in_background=false (for delegation) or run_in_background=true (for parallel exploration)",
    },
    {
      pattern: "load_skills",
      errorType: "missing_load_skills",
      fixHint:
        "Add load_skills=[] parameter (empty array if no skills needed). Note: Calling Skill tool does NOT populate this.",
    },
    {
      pattern: "category OR subagent_type",
      errorType: "mutual_exclusion",
      fixHint: "Provide ONLY one of: category (e.g., 'general', 'quick') OR subagent_type (e.g., 'oracle', 'explore')",
    },
    {
      pattern: "Must provide either category or subagent_type",
      errorType: "missing_category_or_agent",
      fixHint: "Add either category='general' OR subagent_type='explore'",
    },
    {
      pattern: "Unknown category",
      errorType: "unknown_category",
      fixHint: "Use a valid category from the Available list in the error message",
    },
    {
      pattern: "Agent name cannot be empty",
      errorType: "empty_agent",
      fixHint: "Provide a non-empty subagent_type value",
    },
    {
      pattern: "Unknown agent",
      errorType: "unknown_agent",
      fixHint: "Use a valid agent from the Available agents list in the error message",
    },
    {
      pattern: "Cannot call primary agent",
      errorType: "primary_agent",
      fixHint: "Primary agents cannot be called via task. Use a subagent like 'explore', 'oracle', or 'librarian'",
    },
    {
      pattern: "Skills not found",
      errorType: "unknown_skills",
      fixHint: "Use valid skill names from the Available list in the error message",
    },
  ]

  function detectDelegateTaskError(output: string): { errorType: string; originalOutput: string } | null {
    if (!output.includes("[ERROR]") && !output.includes("Invalid arguments")) return null
    for (const errorPattern of DELEGATE_TASK_ERROR_PATTERNS) {
      if (output.includes(errorPattern.pattern)) {
        return { errorType: errorPattern.errorType, originalOutput: output }
      }
    }
    return null
  }

  function extractAvailableList(output: string): string | null {
    const availableMatch = output.match(/Available[^:]*:\s*(.+)$/m)
    return availableMatch ? availableMatch[1]!.trim() : null
  }

  function buildRetryGuidance(errorInfo: { errorType: string; originalOutput: string }): string {
    const pattern = DELEGATE_TASK_ERROR_PATTERNS.find((p) => p.errorType === errorInfo.errorType)
    if (!pattern) return "[task ERROR] Fix the error and retry with correct parameters."

    let guidance = `\n[task CALL FAILED - IMMEDIATE RETRY REQUIRED]\n\n**Error Type**: ${errorInfo.errorType}\n**Fix**: ${pattern.fixHint}`

    const availableList = extractAvailableList(errorInfo.originalOutput)
    if (availableList) {
      guidance += `\n**Available Options**: ${availableList}`
    }

    guidance += `\n\n**Action**: Retry task NOW with corrected parameters.`
    return guidance
  }

  function registerDelegateTaskRetry(): void {
    HookChain.register("delegate-task-retry", "post-tool", 200, async (ctx) => {
      if (ctx.toolName !== "delegate_task" && ctx.toolName !== "task") return
      const output = ctx.result.output

      // First, try structured error pattern detection (specific, actionable guidance)
      const errorInfo = detectDelegateTaskError(output)
      if (errorInfo) {
        ctx.result.output = output + "\n" + buildRetryGuidance(errorInfo)
        log.info("delegate task structured error detected", {
          sessionID: ctx.sessionID,
          errorType: errorInfo.errorType,
        })
        return
      }

      // Fall back to generic failure detection with retry tracking
      const isFailure =
        output.includes("Error") ||
        output.includes("error") ||
        output.includes("failed") ||
        output.includes("Failed") ||
        output.includes("timed out") ||
        output.includes("Timed out")
      if (!isFailure) return

      const retryCount = (ctx.result.metadata as { retryCount?: number } | undefined)?.retryCount ?? 0
      if (retryCount >= 1) {
        ctx.result.output =
          output +
          "\n\nRECOVERY: Delegate task has failed after retry. Consider an alternative approach or investigate the root cause."
        log.info("delegate task retry exhausted", { sessionID: ctx.sessionID, retryCount })
        return
      }

      const delay = 1000 * Math.pow(2, retryCount)
      ctx.result.output =
        output +
        `\n\nRECOVERY: Delegate task failed. Retry recommended after ${delay}ms delay. This is retry attempt ${retryCount + 1} of 2.`
      ctx.result.metadata = {
        ...(ctx.result.metadata as Record<string, unknown> | undefined),
        retryCount: retryCount + 1,
      }
      log.info("delegate task retry suggested", { sessionID: ctx.sessionID, delay, retryCount: retryCount + 1 })
    })
  }

  // --- Iterative error recovery (PostToolChain, priority 300) ---
  // Detects repeated identical error patterns (3+ occurrences), injects corrective guidance

  const errorHistory = new Map<string, Map<string, number>>()

  export function resetErrorHistory(): void {
    errorHistory.clear()
  }

  function getErrorKey(output: string): string {
    // Normalize error output to detect repeated patterns
    // Extract first line or first 200 chars as the error signature
    const firstLine = output.split("\n")[0] ?? ""
    return firstLine.slice(0, 200).trim()
  }

  function registerIterativeErrorRecovery(): void {
    HookChain.register("iterative-error-recovery", "post-tool", 300, async (ctx) => {
      const output = ctx.result.output
      // Only track outputs that look like errors
      const isError =
        output.includes("Error") ||
        output.includes("error:") ||
        output.includes("failed") ||
        output.includes("FAILED") ||
        output.includes("not found") ||
        output.includes("denied")
      if (!isError) return

      const key = getErrorKey(output)
      if (!key) return

      const sessionErrors = errorHistory.get(ctx.sessionID) ?? new Map<string, number>()
      const count = (sessionErrors.get(key) ?? 0) + 1
      sessionErrors.set(key, count)
      errorHistory.set(ctx.sessionID, sessionErrors)

      if (count >= 3) {
        ctx.result.output =
          output +
          `\n\nRECOVERY: This same error has occurred ${count} times. You appear to be in a loop. Stop and reconsider your approach. Try: 1) Re-read the relevant file(s) to get fresh context. 2) Use a different strategy. 3) If stuck, explain the problem and ask for guidance.`
        log.info("iterative error recovery triggered", { sessionID: ctx.sessionID, count, errorKey: key })
      }
    })
  }

  // --- JSON error recovery (PostToolChain, priority 150) ---
  // When tool output contains JSON parse errors, appends corrective guidance
  // to prevent the model from repeating the same invalid JSON call

  const JSON_ERROR_PATTERNS = [
    /json parse error/i,
    /failed to parse json/i,
    /invalid json/i,
    /malformed json/i,
    /unexpected end of json input/i,
    /syntaxerror:\s*unexpected token.*json/i,
    /json[^\n]*expected '\}'/i,
    /json[^\n]*unexpected eof/i,
  ]

  const JSON_ERROR_REMINDER_MARKER = "[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]"

  const JSON_ERROR_EXCLUDED_TOOLS = new Set(["bash", "read", "glob", "grep"])

  const JSON_ERROR_REMINDER = `
${JSON_ERROR_REMINDER_MARKER}

You sent invalid JSON arguments. The system could not parse your tool call.
STOP and do this NOW:

1. LOOK at the error message above to see what was expected vs what you sent.
2. CORRECT your JSON syntax (missing braces, unescaped quotes, trailing commas, etc).
3. RETRY the tool call with valid JSON.

DO NOT repeat the exact same invalid call.
`

  function registerJsonErrorRecovery(): void {
    HookChain.register("json-error-recovery", "post-tool", 150, async (ctx) => {
      if (JSON_ERROR_EXCLUDED_TOOLS.has(ctx.toolName.toLowerCase())) return
      if (typeof ctx.result.output !== "string") return
      if (ctx.result.output.includes(JSON_ERROR_REMINDER_MARKER)) return

      const hasJsonError = JSON_ERROR_PATTERNS.some((pattern) => pattern.test(ctx.result.output))
      if (hasJsonError) {
        ctx.result.output += "\n" + JSON_ERROR_REMINDER
        log.info("json error recovery injected", { sessionID: ctx.sessionID, tool: ctx.toolName })
      }
    })
  }

  // --- Task resume info (PostToolChain, priority 210) ---
  // After successful task/delegate_task, appends session ID hint so the model
  // knows how to continue the task in a follow-up call

  const TASK_TOOLS = new Set(["delegate_task", "task"])

  const SESSION_ID_PATTERNS = [
    /Session ID: (ses_[a-zA-Z0-9_-]+)/,
    /session_id: (ses_[a-zA-Z0-9_-]+)/,
    /<task_metadata>\s*session_id: (ses_[a-zA-Z0-9_-]+)/,
    /sessionId: (ses_[a-zA-Z0-9_-]+)/,
  ]

  function extractSessionId(output: string): string | null {
    for (const pattern of SESSION_ID_PATTERNS) {
      const match = output.match(pattern)
      if (match) return match[1] ?? null
    }
    return null
  }

  function registerTaskResumeInfo(): void {
    HookChain.register("task-resume-info", "post-tool", 210, async (ctx) => {
      if (!TASK_TOOLS.has(ctx.toolName)) return
      const output = ctx.result.output
      if (output.startsWith("Error:") || output.startsWith("Failed")) return
      if (output.includes("\nto continue:")) return

      const sessionId = extractSessionId(output)
      if (!sessionId) return

      ctx.result.output = output.trimEnd() + `\n\nto continue: task(session_id="${sessionId}", prompt="...")`
      log.info("task resume info injected", { sessionID: ctx.sessionID, taskSessionID: sessionId })
    })
  }

  // --- Register all error recovery hooks ---

  export function register(): void {
    registerEditErrorRecovery()
    registerContextWindowLimitRecovery()
    registerDelegateTaskRetry()
    registerIterativeErrorRecovery()
    registerJsonErrorRecovery()
    registerTaskResumeInfo()
  }
}
