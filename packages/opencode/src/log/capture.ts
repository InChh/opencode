import { Log } from "../util/log"
import { HookChain } from "../session/hooks"
import { Instance } from "../project/instance"
import { Database } from "../storage/db"
import {
  LlmLogTable,
  LlmLogRequestTable,
  LlmLogResponseTable,
  LlmLogTokensTable,
  LlmLogToolCallTable,
  LlmLogAnnotationTable,
} from "./log.sql"
import { Identifier } from "../id/id"
import { Config } from "../config/config"
import { eq, and } from "drizzle-orm"
import { currentLlmLogState, getCurrentLogId as getCurrentLogId_impl } from "./log-state"
import { MessageV2 } from "../session/message-v2"

export namespace LlmLogCapture {
  const log = Log.create({ service: "llm-log-capture" })

  function parseParts(parts: unknown[]) {
    let text = ""
    const calls: Array<{ id: string; name: string; args: unknown }> = []

    for (const part of parts) {
      if (!part || typeof part !== "object") continue

      const type = "type" in part && typeof part.type === "string" ? part.type : ""
      if (type === "text") {
        if ("text" in part && typeof part.text === "string") text += part.text
        continue
      }

      if (type === "tool") {
        calls.push({
          id: "callID" in part && typeof part.callID === "string" ? part.callID : "",
          name: "tool" in part && typeof part.tool === "string" ? part.tool : "",
          args:
            "state" in part && part.state && typeof part.state === "object" && "input" in part.state
              ? part.state.input
              : {},
        })
        continue
      }

      if (type === "tool-invocation" || type === "tool-call") {
        calls.push({
          id:
            "toolCallId" in part && typeof part.toolCallId === "string"
              ? part.toolCallId
              : "id" in part && typeof part.id === "string"
                ? part.id
                : "",
          name:
            "toolName" in part && typeof part.toolName === "string"
              ? part.toolName
              : "name" in part && typeof part.name === "string"
                ? part.name
                : "",
          args: "args" in part ? part.args : {},
        })
      }
    }

    return {
      text,
      calls,
    }
  }

  // Per-instance state: Map<"sessionID:callID", timeStart> for tool call duration tracking
  const toolCallStartState = Instance.state(() => new Map<string, number>())

  export function getCurrentLogId(sessionID: string): string | undefined {
    return getCurrentLogId_impl(sessionID)
  }

  /**
   * Update the request row with headers after they are assembled.
   * Headers are built after the pre-llm hook, so we capture them separately.
   */
  export function captureHeaders(sessionID: string, headers: Record<string, string | undefined>): void {
    const logId = getCurrentLogId(sessionID)
    if (!logId) return
    try {
      const filtered = Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => e[1] != null))
      Database.use((db) => {
        db.update(LlmLogRequestTable).set({ headers: filtered }).where(eq(LlmLogRequestTable.llm_log_id, logId)).run()
      })
    } catch (err) {
      log.error("failed to capture request headers", {
        error: err instanceof Error ? err.message : String(err),
        sessionID,
      })
    }
  }

  export function register(): void {
    HookChain.register("llm-log-capture", "pre-llm", 999, async (ctx) => {
      if (ctx.metadata?.background) return

      const config = await Config.get()
      if (config.llmLog?.enabled === false) return

      const llmLogId = Identifier.ascending("log")
      const now = Date.now()

      try {
        const systemPrompt = Bun.gzipSync(Buffer.from(ctx.system.join("\n")))
        const messages = Bun.gzipSync(Buffer.from(JSON.stringify(ctx.messages)))

        Database.use((db) => {
          db.insert(LlmLogTable)
            .values({
              id: llmLogId,
              session_id: ctx.sessionID,
              agent: ctx.agent,
              model: ctx.model,
              provider: ctx.model.split("/")[0] ?? ctx.model,
              variant: ctx.variant ?? null,
              status: "pending",
              time_start: now,
            })
            .run()

          db.insert(LlmLogRequestTable)
            .values({
              id: Identifier.ascending("log"),
              llm_log_id: llmLogId,
              system_prompt: systemPrompt,
              messages: messages,
              tools: ctx.providerOptions ?? null,
              options: ctx.providerOptions ?? null,
            })
            .run()
        })

        currentLlmLogState().set(ctx.sessionID, { logId: llmLogId, timeStart: now })
        log.info("captured pre-llm log", { llmLogId, sessionID: ctx.sessionID, agent: ctx.agent })
      } catch (err) {
        log.error("failed to capture pre-llm log", {
          error: err instanceof Error ? err.message : String(err),
          sessionID: ctx.sessionID,
        })
      }

      // Record prompt prefix hash for cache stability analysis
      try {
        const prefix = ctx.system.join("\n").slice(0, 2000)
        if (prefix.length > 0) {
          const hash = Bun.hash(prefix).toString(16)
          Database.use((db) => {
            db.insert(LlmLogAnnotationTable)
              .values({
                id: Identifier.ascending("log"),
                llm_log_id: llmLogId,
                type: "prompt_prefix_hash",
                content: hash,
                marked_text: null,
                time_created: now,
                time_updated: now,
              })
              .run()
          })
        }
      } catch {}
    })

    HookChain.register("llm-log-tool-start", "pre-tool", 999, async (ctx) => {
      const config = await Config.get()
      if (config.llmLog?.enabled === false) return

      const llmLogId = getCurrentLogId(ctx.sessionID)
      if (!llmLogId) return

      const callId = ctx.metadata?.callID as string | undefined
      const now = Date.now()

      try {
        const toolCallId = Identifier.ascending("log")

        Database.use((db) => {
          db.insert(LlmLogToolCallTable)
            .values({
              id: toolCallId,
              llm_log_id: llmLogId,
              call_id: callId ?? null,
              tool_name: ctx.toolName,
              input: ctx.args,
              status: "running",
              time_start: now,
            })
            .run()
        })

        // Store start time keyed by sessionID:callID for duration calculation in post-tool hook
        const key = `${ctx.sessionID}:${callId ?? ctx.toolName}`
        toolCallStartState().set(key, now)

        log.info("captured tool call start", { toolCallId, toolName: ctx.toolName, llmLogId })
      } catch (err) {
        log.error("failed to capture tool call start", {
          error: err instanceof Error ? err.message : String(err),
          sessionID: ctx.sessionID,
          toolName: ctx.toolName,
        })
      }
    })

    HookChain.register("llm-log-tool-finish", "post-tool", 0, async (ctx) => {
      const config = await Config.get()
      if (config.llmLog?.enabled === false) return

      const llmLogId = getCurrentLogId(ctx.sessionID)
      if (!llmLogId) return

      const callId = ctx.metadata?.callID as string | undefined
      const now = Date.now()

      try {
        const key = `${ctx.sessionID}:${callId ?? ctx.toolName}`
        const startTime = toolCallStartState().get(key)
        const durationMs = startTime ? now - startTime : null
        toolCallStartState().delete(key)

        const outputStr = ctx.result.output ?? ""
        const outputBytes = Buffer.byteLength(outputStr, "utf8")

        Database.use((db) => {
          db.update(LlmLogToolCallTable)
            .set({
              output: { output: outputStr, title: ctx.result.title },
              title: ctx.result.title ?? null,
              status: "success",
              time_end: now,
              duration_ms: durationMs,
              output_bytes: outputBytes,
            })
            .where(
              and(
                eq(LlmLogToolCallTable.llm_log_id, llmLogId),
                callId ? eq(LlmLogToolCallTable.call_id, callId) : eq(LlmLogToolCallTable.tool_name, ctx.toolName),
                eq(LlmLogToolCallTable.status, "running"),
              ),
            )
            .run()
        })

        log.info("captured tool call finish", { toolName: ctx.toolName, llmLogId, durationMs })
      } catch (err) {
        log.error("failed to capture tool call finish", {
          error: err instanceof Error ? err.message : String(err),
          sessionID: ctx.sessionID,
          toolName: ctx.toolName,
        })
      }
    })

    HookChain.register("llm-log-response-capture", "session-lifecycle", 999, async (ctx) => {
      if (ctx.event !== "step.finished") return

      const config = await Config.get()
      if (config.llmLog?.enabled === false) return

      const logState = currentLlmLogState().get(ctx.sessionID)
      if (!logState) return
      const { logId: llmLogId, timeStart } = logState

      const data = ctx.data as {
        usage: {
          cost: number
          tokens: {
            total: number
            input: number
            output: number
            reasoning: number
            cache: { write: number; read: number }
          }
        }
        finishReason: string
        model: { id: string; cost?: Record<string, any> }
        assistantMessage: { id: string; parts?: unknown[] }
        response?: { id?: string; timestamp?: Date; modelId?: string; headers?: Record<string, string> }
      }

      const now = Date.now()

      try {
        const parsed = parseParts(data.assistantMessage.parts ?? (await MessageV2.parts(data.assistantMessage.id)))

        const status = data.finishReason === "error" ? "error" : data.finishReason === "abort" ? "aborted" : "success"

        const rawResponseData = {
          finishReason: data.finishReason,
          modelId: data.response?.modelId ?? data.model.id,
          id: data.response?.id,
          timestamp: data.response?.timestamp,
          headers: data.response?.headers,
        }
        const rawResponse = Bun.gzipSync(Buffer.from(JSON.stringify(rawResponseData)))

        Database.use((db) => {
          db.insert(LlmLogResponseTable)
            .values({
              id: Identifier.ascending("log"),
              llm_log_id: llmLogId,
              completion_text: parsed.text || null,
              tool_calls: parsed.calls.length > 0 ? parsed.calls : null,
              raw_response: rawResponse,
              error: status === "error" ? { finishReason: data.finishReason } : null,
            })
            .run()

          db.insert(LlmLogTokensTable)
            .values({
              id: Identifier.ascending("log"),
              llm_log_id: llmLogId,
              input_tokens: data.usage.tokens.input,
              output_tokens: data.usage.tokens.output,
              reasoning_tokens: data.usage.tokens.reasoning,
              cache_read_tokens: data.usage.tokens.cache.read,
              cache_write_tokens: data.usage.tokens.cache.write,
              cost: Math.round(data.usage.cost * 1_000_000),
            })
            .run()

          db.update(LlmLogTable)
            .set({
              time_end: now,
              duration_ms: now - timeStart,
              status,
            })
            .where(eq(LlmLogTable.id, llmLogId))
            .run()
        })

        log.info("captured response log", { llmLogId, sessionID: ctx.sessionID, status })
      } catch (err) {
        log.error("failed to capture response log", {
          error: err instanceof Error ? err.message : String(err),
          sessionID: ctx.sessionID,
          llmLogId,
        })
      }
    })

    // Finalize pending logs on error/abort so they don't stay "pending" forever
    HookChain.register("llm-log-error-capture", "session-lifecycle", 998, async (ctx) => {
      if (ctx.event !== "session.error" && ctx.event !== "agent.error") return

      const config = await Config.get()
      if (config.llmLog?.enabled === false) return

      const logState = currentLlmLogState().get(ctx.sessionID)
      if (!logState) return
      const { logId: llmLogId, timeStart } = logState

      const now = Date.now()
      const status = ctx.event === "agent.error" ? "aborted" : "error"

      try {
        const error = (ctx.data as { error?: unknown })?.error ?? null
        const serialized = error
          ? typeof error === "object" && "name" in (error as any)
            ? { name: (error as any).name, message: (error as any).message, ...(error as any).data }
            : { message: String(error) }
          : null

        // Only update if still pending (step.finished may have already finalized it)
        Database.use((db) => {
          const row = db
            .select({ status: LlmLogTable.status })
            .from(LlmLogTable)
            .where(eq(LlmLogTable.id, llmLogId))
            .get()
          if (!row || row.status !== "pending") return

          db.update(LlmLogTable)
            .set({
              time_end: now,
              duration_ms: now - timeStart,
              status,
            })
            .where(eq(LlmLogTable.id, llmLogId))
            .run()

          // Write error details into response table so log-viewer can display them
          if (serialized) {
            db.insert(LlmLogResponseTable)
              .values({
                id: Identifier.ascending("log"),
                llm_log_id: llmLogId,
                completion_text: null,
                tool_calls: null,
                raw_response: null,
                error: serialized,
              })
              .run()
          }
        })

        log.info("finalized pending log on error", { llmLogId, sessionID: ctx.sessionID, status })
      } catch (err) {
        log.error("failed to finalize pending log on error", {
          error: err instanceof Error ? err.message : String(err),
          sessionID: ctx.sessionID,
          llmLogId,
        })
      }
    })
  }
}
