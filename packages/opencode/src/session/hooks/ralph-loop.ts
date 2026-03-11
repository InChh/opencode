import { Bus } from "../../bus"
import { Log } from "../../util/log"
import { SessionStatus } from "../status"
import { HookChain } from "./index"

// Lazy imports to avoid circular dependency at module load time.
// Session, SessionPrompt, and TuiEvent are resolved on first use.
let _Session: typeof import("../index").Session | undefined
let _SessionPrompt: typeof import("../prompt").SessionPrompt | undefined
let _TuiEvent: typeof import("../../cli/cmd/tui/event").TuiEvent | undefined
let _Command: typeof import("../../command").Command | undefined

async function getSession() {
  if (!_Session) _Session = (await import("../index")).Session
  return _Session
}
async function getSessionPrompt() {
  if (!_SessionPrompt) _SessionPrompt = (await import("../prompt")).SessionPrompt
  return _SessionPrompt
}
async function getTuiEvent() {
  if (!_TuiEvent) _TuiEvent = (await import("../../cli/cmd/tui/event")).TuiEvent
  return _TuiEvent
}
async function getCommand() {
  if (!_Command) _Command = (await import("../../command")).Command
  return _Command
}

export namespace RalphLoop {
  const log = Log.create({ service: "ralph-loop" })

  // --- Constants ---

  const DEFAULT_MAX_ITERATIONS = 100
  const DEFAULT_COMPLETION_PROMISE = "DONE"
  const ULTRAWORK_VERIFICATION_PROMISE = "VERIFIED"

  // --- Types ---

  export interface LoopState {
    active: boolean
    iteration: number
    maxIterations: number
    completionPromise: string
    initialCompletionPromise: string
    prompt: string
    sessionID: string
    startedAt: string
    ultrawork: boolean
    verificationPending: boolean
    verificationSessionID?: string
    messageCountAtStart: number
  }

  export interface StartOptions {
    maxIterations?: number
    completionPromise?: string
    ultrawork?: boolean
  }

  // --- State (module-level, keyed by sessionID) ---

  const loops = new Map<string, LoopState>()
  const inFlight = new Set<string>()

  // --- Prompt Templates ---

  function buildContinuationPrompt(loopState: LoopState): string {
    const maxLabel = String(loopState.maxIterations)
    const prefix = loopState.ultrawork ? "ultrawork " : ""

    if (loopState.verificationPending) {
      return `${prefix}[SYSTEM DIRECTIVE - ULTRAWORK LOOP VERIFICATION ${loopState.iteration}/${maxLabel}]

You already emitted <promise>${loopState.initialCompletionPromise}</promise>. This does NOT finish the loop yet.

REQUIRED NOW:
- Call Oracle using task(subagent_type="oracle", load_skills=[], run_in_background=false, ...)
- Ask Oracle to verify whether the original task is actually complete
- The system will inspect the Oracle session directly for the verification result
- If Oracle does not verify, continue fixing the task and do not consider it complete

Original task:
${loopState.prompt}`
    }

    return `${prefix}[SYSTEM DIRECTIVE - RALPH LOOP ${loopState.iteration}/${maxLabel}]

Your previous attempt did not output the completion promise. Continue working on the task.

IMPORTANT:
- Review your progress so far
- Continue from where you left off
- When FULLY complete, output: <promise>${loopState.completionPromise}</promise>
- Do not stop until the task is truly done

Original task:
${loopState.prompt}`
  }

  function buildVerificationFailurePrompt(loopState: LoopState): string {
    const maxLabel = String(loopState.maxIterations)
    const prefix = loopState.ultrawork ? "ultrawork " : ""

    return `${prefix}[SYSTEM DIRECTIVE - ULTRAWORK LOOP VERIFICATION FAILED ${loopState.iteration}/${maxLabel}]

Oracle did not emit <promise>VERIFIED</promise>. Verification failed.

REQUIRED NOW:
- Verification failed. Fix the task until Oracle's review is satisfied
- Oracle does not lie. Treat the verification result as ground truth
- Do not claim completion early or argue with the failed verification
- After fixing the remaining issues, request Oracle review again using task(subagent_type="oracle", load_skills=[], run_in_background=false, ...)
- Only when the work is ready for review again, output: <promise>${loopState.completionPromise}</promise>

Original task:
${loopState.prompt}`
  }

  // --- Completion Detection ---

  function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  async function detectCompletion(
    sessionID: string,
    promise: string,
    sinceMessageIndex: number,
  ): Promise<boolean> {
    const Session = await getSession()
    const msgs = await Session.messages({ sessionID })
    const pattern = new RegExp(`<promise>\\s*${escapeRegex(promise)}\\s*</promise>`, "is")

    // msgs are newest-first from Session.messages, take only those after sinceMessageIndex
    const scopedMsgs =
      sinceMessageIndex > 0 && sinceMessageIndex < msgs.length
        ? msgs.slice(0, msgs.length - sinceMessageIndex)
        : msgs

    for (const msg of scopedMsgs) {
      if (msg.info.role !== "assistant") continue
      let text = ""
      for (const part of msg.parts) {
        if (part.type === "text" && "text" in part) {
          text += (text ? "\n" : "") + ((part as { text?: string }).text ?? "")
        }
      }
      if (pattern.test(text)) return true
    }
    return false
  }

  // --- Toast Helper ---

  async function showToast(title: string, message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> {
    const TuiEvent = await getTuiEvent()
    Bus.publish(TuiEvent.ToastShow, { title, message, variant })
  }

  // --- Loop Control ---

  export async function start(sessionID: string, prompt: string, options?: StartOptions): Promise<boolean> {
    if (!registered) return false
    ensureSubscribed()

    const existing = loops.get(sessionID)
    if (existing?.active) {
      log.info("loop already active for session, overwriting", { sessionID })
    }

    const loopState: LoopState = {
      active: true,
      iteration: 1,
      maxIterations: options?.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      completionPromise: options?.completionPromise ?? DEFAULT_COMPLETION_PROMISE,
      initialCompletionPromise: options?.completionPromise ?? DEFAULT_COMPLETION_PROMISE,
      prompt,
      sessionID,
      startedAt: new Date().toISOString(),
      ultrawork: options?.ultrawork ?? false,
      verificationPending: false,
      messageCountAtStart: 0,
    }

    loops.set(sessionID, loopState)

    // Async: fetch initial message count
    const Session = await getSession()
    Session.messages({ sessionID })
      .then((msgs) => {
        const current = loops.get(sessionID)
        if (current?.active) {
          current.messageCountAtStart = msgs.length
        }
      })
      .catch(() => {})

    log.info("loop started", {
      sessionID,
      maxIterations: loopState.maxIterations,
      ultrawork: loopState.ultrawork,
      completionPromise: loopState.completionPromise,
    })

    await showToast(
      loopState.ultrawork ? "ULTRAWORK LOOP" : "Ralph Loop",
      `Loop started. Will continue until <promise>${loopState.completionPromise}</promise> is emitted.`,
      "info",
    )

    return true
  }

  export async function cancel(sessionID: string): Promise<boolean> {
    const loopState = loops.get(sessionID)
    if (!loopState?.active) return false

    loops.delete(sessionID)
    log.info("loop cancelled", { sessionID })

    await showToast("Ralph Loop", `Loop cancelled after ${loopState.iteration} iteration(s).`, "info")

    return true
  }

  export function getState(sessionID: string): LoopState | null {
    return loops.get(sessionID) ?? null
  }

  export function listActive(): ReadonlyArray<{ sessionID: string; iteration: number; maxIterations: number }> {
    const result: Array<{ sessionID: string; iteration: number; maxIterations: number }> = []
    for (const [, loopState] of loops) {
      if (loopState.active) {
        result.push({
          sessionID: loopState.sessionID,
          iteration: loopState.iteration,
          maxIterations: loopState.maxIterations,
        })
      }
    }
    return result
  }

  // --- Idle Handler ---

  async function handleIdle(sessionID: string): Promise<void> {
    // Prevent concurrent handling
    if (inFlight.has(sessionID)) return
    const loopState = loops.get(sessionID)
    if (!loopState?.active) {
      // Check if this session is an oracle verification session
      for (const [, ls] of loops) {
        if (ls.verificationSessionID === sessionID && ls.active) {
          if (inFlight.has(ls.sessionID)) return
          inFlight.add(ls.sessionID)
          try {
            await processIdle(ls, true)
          } finally {
            inFlight.delete(ls.sessionID)
          }
          return
        }
      }
      return
    }

    inFlight.add(sessionID)
    try {
      await processIdle(loopState, false)
    } finally {
      inFlight.delete(sessionID)
    }
  }

  async function processIdle(loopState: LoopState, isOracleIdle: boolean): Promise<void> {
    const { sessionID } = loopState

    // Check for ultrawork verification result
    if (loopState.verificationPending && loopState.verificationSessionID) {
      const verified = await detectCompletion(
        isOracleIdle ? loopState.verificationSessionID : sessionID,
        ULTRAWORK_VERIFICATION_PROMISE,
        0,
      )

      if (verified) {
        // Verification passed — loop complete
        loops.delete(sessionID)
        log.info("ultrawork loop verified and complete", { sessionID, iteration: loopState.iteration })
        await showToast(
          "ULTRAWORK LOOP COMPLETE!",
          `Task completed and verified after ${loopState.iteration} iteration(s)`,
          "success",
        )
        return
      }

      if (isOracleIdle) {
        // Oracle finished but didn't verify — verification failed
        await handleVerificationFailure(loopState)
        return
      }

      // Parent session idle while awaiting verification — wait for oracle
      return
    }

    // Check for completion promise in session messages
    const completed = await detectCompletion(
      sessionID,
      loopState.completionPromise,
      loopState.messageCountAtStart,
    )

    if (completed) {
      await handleCompletion(loopState)
      return
    }

    // Not completed — continue iteration
    if (loopState.iteration >= loopState.maxIterations) {
      loops.delete(sessionID)
      log.info("loop max iterations reached", { sessionID, iteration: loopState.iteration })
      await showToast("Ralph Loop", `Max iterations (${loopState.maxIterations}) reached without completion.`, "warning")
      return
    }

    loopState.iteration++
    log.info("loop continuing", { sessionID, iteration: loopState.iteration })

    const prompt = buildContinuationPrompt(loopState)
    await injectPrompt(sessionID, prompt)
  }

  async function handleCompletion(loopState: LoopState): Promise<void> {
    const { sessionID } = loopState

    // Ultrawork: transition to verification phase
    if (loopState.ultrawork && !loopState.verificationPending) {
      loopState.verificationPending = true
      loopState.completionPromise = ULTRAWORK_VERIFICATION_PROMISE

      const prompt = buildContinuationPrompt(loopState)
      await injectPrompt(sessionID, prompt)

      await showToast("ULTRAWORK LOOP", "DONE detected. Oracle verification is now required.", "info")
      log.info("ultrawork verification phase started", { sessionID, iteration: loopState.iteration })
      return
    }

    // Normal completion (or verified ultrawork)
    loops.delete(sessionID)
    const title = loopState.ultrawork ? "ULTRAWORK LOOP COMPLETE!" : "Ralph Loop Complete!"
    const message = `Task completed after ${loopState.iteration} iteration(s)`
    log.info("loop completed", { sessionID, iteration: loopState.iteration })
    await showToast(title, message, "success")
  }

  async function handleVerificationFailure(loopState: LoopState): Promise<void> {
    const { sessionID } = loopState

    // Reset to pre-verification state
    loopState.verificationPending = false
    loopState.completionPromise = loopState.initialCompletionPromise
    loopState.verificationSessionID = undefined
    loopState.iteration++

    // Update message count baseline
    const Session = await getSession()
    const msgs = await Session.messages({ sessionID }).catch(() => [] as never[])
    loopState.messageCountAtStart = msgs.length

    const prompt = buildVerificationFailurePrompt(loopState)
    await injectPrompt(sessionID, prompt)

    log.info("ultrawork verification failed, continuing", { sessionID, iteration: loopState.iteration })
    await showToast("ULTRAWORK LOOP", "Oracle verification failed. Resuming work.", "warning")
  }

  // --- Prompt Injection ---

  async function injectPrompt(sessionID: string, text: string): Promise<void> {
    const SessionPrompt = await getSessionPrompt()
    await SessionPrompt.prompt({
      sessionID,
      parts: [{ type: "text", text }],
    }).catch((err: unknown) => {
      log.error("failed to inject continuation prompt", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // --- Track Oracle Sessions ---

  export function setVerificationSession(parentSessionID: string, oracleSessionID: string): void {
    const loopState = loops.get(parentSessionID)
    if (!loopState?.verificationPending) return
    loopState.verificationSessionID = oracleSessionID
    log.info("oracle verification session bound", { parentSessionID, oracleSessionID })
  }

  // --- Registration ---
  // Bus.subscribe requires Instance context, so we defer actual subscription
  // until the first session idle event is possible (i.e., until start() is called).

  let registered = false
  let unsubscribeIdle: (() => void) | undefined
  let unsubscribeCommand: (() => void) | undefined

  const RALPH_LOOP_COMMANDS = new Set(["ralph-loop", "ultrawork"])

  function ensureSubscribed(): void {
    if (unsubscribeIdle) return

    unsubscribeIdle = Bus.subscribe(SessionStatus.Event.Status, async (evt) => {
      if (evt.properties.status.type !== "idle") return
      await handleIdle(evt.properties.sessionID).catch((err: unknown) => {
        log.error("idle handler error", {
          sessionID: evt.properties.sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    })

    // Subscribe to command execution to auto-start loops from /ralph-loop and /ultrawork
    getCommand()
      .then((Command) => {
        unsubscribeCommand = Bus.subscribe(Command.Event.Executed, async (evt) => {
          if (!RALPH_LOOP_COMMANDS.has(evt.properties.name)) return
          const sessionID = evt.properties.sessionID
          const prompt = evt.properties.arguments
          const isUltrawork = evt.properties.name === "ultrawork"

          await start(sessionID, prompt, { ultrawork: isUltrawork })

          // The command already ran the first LLM turn via prompt().
          // The session may already be idle, so immediately check for completion.
          await handleIdle(sessionID).catch((err: unknown) => {
            log.error("post-command idle check error", {
              sessionID,
              error: err instanceof Error ? err.message : String(err),
            })
          })
        })
      })
      .catch((err: unknown) => {
        log.error("failed to subscribe to Command.Event.Executed", {
          error: err instanceof Error ? err.message : String(err),
        })
      })

    log.info("ralph-loop bus subscription active")
  }

  export function register(): void {
    registered = true

    // Use a session-lifecycle hook to activate Bus subscriptions once Instance context is available.
    // This ensures the /ralph-loop and /ultrawork command listeners are ready before any command fires.
    HookChain.register("ralph-loop-activator", "session-lifecycle", 999, async () => {
      ensureSubscribed()
    })

    log.info("ralph-loop registered (subscription deferred until first session event)")
  }

  export function unregister(): void {
    registered = false
    if (unsubscribeIdle) {
      unsubscribeIdle()
      unsubscribeIdle = undefined
    }
    if (unsubscribeCommand) {
      unsubscribeCommand()
      unsubscribeCommand = undefined
    }
  }

  // --- Reset (for testing) ---

  export function reset(): void {
    unregister()
    loops.clear()
    inFlight.clear()
  }
}
