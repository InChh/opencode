import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { LlmLog } from "./query"
import { Log } from "../util/log"
import { NotFoundError } from "../storage/db"
import { lazy } from "../util/lazy"

declare const OPENCODE_LOG_VIEWER_ASSETS: Record<string, { content: string; contentType: string }> | undefined

const log = Log.create({ service: "log-viewer-routes" })

let cached: Map<string, { data: Uint8Array; contentType: string }> | undefined

function assets(): Map<string, { data: Uint8Array; contentType: string }> | undefined {
  if (cached !== undefined) return cached.size > 0 ? cached : undefined
  if (typeof OPENCODE_LOG_VIEWER_ASSETS === "undefined" || !OPENCODE_LOG_VIEWER_ASSETS) {
    cached = new Map()
    return undefined
  }
  cached = new Map()
  for (const [p, asset] of Object.entries(OPENCODE_LOG_VIEWER_ASSETS)) {
    cached.set(p, { data: Buffer.from(asset.content, "base64"), contentType: asset.contentType })
  }
  log.info("loaded embedded log-viewer assets", { count: cached.size })
  return cached.size > 0 ? cached : undefined
}

function listFilters(c: { req: { query: (k: string) => string | undefined } }) {
  return {
    session_id: c.req.query("session_id") || undefined,
    agent: c.req.query("agent") || undefined,
    model: c.req.query("model") || undefined,
    provider: c.req.query("provider") || undefined,
    status: c.req.query("status") || undefined,
    time_start: c.req.query("time_start") ? Number(c.req.query("time_start")) : undefined,
    time_end: c.req.query("time_end") ? Number(c.req.query("time_end")) : undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    offset: c.req.query("offset") ? Number(c.req.query("offset")) : undefined,
  }
}

function statsFilters(c: { req: { query: (k: string) => string | undefined } }) {
  return {
    session_id: c.req.query("session_id") || undefined,
    agent: c.req.query("agent") || undefined,
    model: c.req.query("model") || undefined,
    provider: c.req.query("provider") || undefined,
    time_start: c.req.query("time_start") ? Number(c.req.query("time_start")) : undefined,
    time_end: c.req.query("time_end") ? Number(c.req.query("time_end")) : undefined,
    group_by: (c.req.query("group_by") as "model" | "agent" | "session" | "hour" | "day") || undefined,
  }
}

function analyzeFilters(c: { req: { query: (k: string) => string | undefined } }) {
  return {
    session_id: c.req.query("session_id") || undefined,
    agent: c.req.query("agent") || undefined,
    model: c.req.query("model") || undefined,
    provider: c.req.query("provider") || undefined,
    time_start: c.req.query("time_start") ? Number(c.req.query("time_start")) : undefined,
    time_end: c.req.query("time_end") ? Number(c.req.query("time_end")) : undefined,
  }
}

const FALLBACK_HTML = `<!DOCTYPE html><html><head><title>OpenCode Log Viewer</title></head><body><h1>OpenCode Log Viewer</h1><p>Log viewer assets not found. API available at /log-viewer/api/</p></body></html>`

function serveAsset(pathname: string) {
  const loaded = assets()
  if (!loaded) return new Response(FALLBACK_HTML, { headers: { "Content-Type": "text/html" } })

  const key = pathname === "/" || pathname === "" ? "/index.html" : pathname
  const asset = loaded.get(key)
  if (asset) {
    return new Response(asset.data.buffer as ArrayBuffer, {
      headers: { "Content-Type": asset.contentType },
    })
  }

  // SPA fallback
  const index = loaded.get("/index.html")
  if (index) {
    return new Response(index.data.buffer as ArrayBuffer, {
      headers: { "Content-Type": "text/html" },
    })
  }

  return new Response(FALLBACK_HTML, { headers: { "Content-Type": "text/html" } })
}

export const LogViewerRoutes = lazy(() =>
  new Hono()
    .get(
      "/api/health",
      describeRoute({
        summary: "Log viewer health check",
        operationId: "logViewer.health",
      }),
      (c) => c.json({ status: "ok" }),
    )
    .get(
      "/api/logs/stats",
      describeRoute({
        summary: "Log statistics",
        operationId: "logViewer.stats",
      }),
      (c) => c.json(LlmLog.stats(statsFilters(c))),
    )
    .get(
      "/api/logs/analyze",
      describeRoute({
        summary: "Log optimization analysis",
        operationId: "logViewer.analyze",
      }),
      (c) => c.json(LlmLog.analyze(analyzeFilters(c))),
    )
    .post(
      "/api/logs/cleanup",
      describeRoute({
        summary: "Cleanup old logs",
        operationId: "logViewer.cleanup",
      }),
      async (c) => {
        const body = await c.req.json().catch(() => ({}))
        return c.json(LlmLog.cleanup(body))
      },
    )
    .get(
      "/api/logs",
      describeRoute({
        summary: "List LLM logs",
        operationId: "logViewer.list",
      }),
      (c) => c.json(LlmLog.list(listFilters(c))),
    )
    .delete(
      "/api/logs/annotations/:annotationId",
      describeRoute({
        summary: "Delete annotation",
        operationId: "logViewer.deleteAnnotation",
      }),
      (c) => {
        LlmLog.deleteAnnotation(c.req.param("annotationId"))
        return c.json({ success: true })
      },
    )
    .post(
      "/api/logs/:id/annotations",
      describeRoute({
        summary: "Add annotation",
        operationId: "logViewer.annotate",
      }),
      async (c) => {
        const body = await c.req.json()
        return c.json(LlmLog.annotate(c.req.param("id"), body), 201)
      },
    )
    .get(
      "/api/logs/:id",
      describeRoute({
        summary: "Get log detail",
        operationId: "logViewer.get",
      }),
      (c) => c.json(LlmLog.get(c.req.param("id"))),
    )
    .get("/app", (c) => {
      const resp = serveAsset("/index.html")
      return c.newResponse(resp.body, {
        headers: { "Content-Type": "text/html" },
      })
    })
    .get("/app/*", (c) => {
      // Extract the sub-path after /app from the full URL path
      const url = new URL(c.req.url)
      const match = url.pathname.match(/\/app(\/.*)$/)
      const sub = match ? match[1] : "/"
      const resp = serveAsset(sub)
      return c.newResponse(resp.body, {
        headers: { "Content-Type": resp.headers.get("Content-Type") || "text/html" },
      })
    })
    .onError((err, c) => {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message }, 404)
      }
      log.error("api error", { error: err })
      return c.json({ error: err instanceof Error ? err.message : "Internal server error" }, 500)
    }),
)
