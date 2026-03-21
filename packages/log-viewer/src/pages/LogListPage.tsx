import { useState, useEffect, useCallback } from "react"
import { useNavigate, useSearchParams } from "react-router"

interface LogItem {
  id: string
  session_id: string
  agent: string
  model: string
  provider: string
  variant: string | null
  status: string
  time_start: number
  time_end: number | null
  duration_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cost: number | null
}

interface ListResponse {
  items: LogItem[]
  total: number
}

interface Filters {
  session_id: string
  agent: string
  model: string
  provider: string
  status: string
}

const PAGE_SIZE = 50

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "-"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(n: number | null): string {
  if (n == null) return "-"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(microdollars: number | null): string {
  if (microdollars == null) return "-"
  const dollars = microdollars / 1_000_000
  if (dollars < 0.001) return "<$0.001"
  return `$${dollars.toFixed(3)}`
}

const statusColors: Record<string, string> = {
  success: "text-green-400",
  error: "text-red-400",
  aborted: "text-yellow-400",
  pending: "text-zinc-400",
}

export function LogListPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(() => {
    const p = searchParams.get("page")
    return p ? Math.max(0, parseInt(p, 10) - 1) : 0
  })

  const [filters, setFilters] = useState<Filters>({
    session_id: searchParams.get("session_id") ?? "",
    agent: searchParams.get("agent") ?? "",
    model: searchParams.get("model") ?? "",
    provider: searchParams.get("provider") ?? "",
    status: searchParams.get("status") ?? "",
  })

  const [filterInput, setFilterInput] = useState<Filters>({ ...filters })

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)

    const params = new URLSearchParams()
    params.set("limit", String(PAGE_SIZE))
    params.set("offset", String(page * PAGE_SIZE))
    if (filters.session_id) params.set("session_id", filters.session_id)
    if (filters.agent) params.set("agent", filters.agent)
    if (filters.model) params.set("model", filters.model)
    if (filters.provider) params.set("provider", filters.provider)
    if (filters.status) params.set("status", filters.status)

    try {
      const res = await fetch(`/log-viewer/api/logs?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: ListResponse = await res.json()
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch logs")
    } finally {
      setLoading(false)
    }
  }, [page, filters])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (page > 0) params.page = String(page + 1)
    if (filters.session_id) params.session_id = filters.session_id
    if (filters.agent) params.agent = filters.agent
    if (filters.model) params.model = filters.model
    if (filters.provider) params.provider = filters.provider
    if (filters.status) params.status = filters.status
    setSearchParams(params, { replace: true })
  }, [page, filters, setSearchParams])

  function applyFilters() {
    setPage(0)
    setFilters({ ...filterInput })
  }

  function clearFilters() {
    const empty: Filters = { session_id: "", agent: "", model: "", provider: "", status: "" }
    setFilterInput(empty)
    setPage(0)
    setFilters(empty)
  }

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0

  return (
    <div className="space-y-4">
      {/* Filter Panel */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="flex items-end gap-3 flex-wrap">
          <FilterField
            label="Session ID"
            value={filterInput.session_id}
            onChange={(v) => setFilterInput((f) => ({ ...f, session_id: v }))}
            placeholder="Filter by session..."
          />
          <FilterField
            label="Agent"
            value={filterInput.agent}
            onChange={(v) => setFilterInput((f) => ({ ...f, agent: v }))}
            placeholder="e.g. sisyphus"
          />
          <FilterField
            label="Model"
            value={filterInput.model}
            onChange={(v) => setFilterInput((f) => ({ ...f, model: v }))}
            placeholder="e.g. claude-sonnet-4-20250514"
          />
          <FilterField
            label="Provider"
            value={filterInput.provider}
            onChange={(v) => setFilterInput((f) => ({ ...f, provider: v }))}
            placeholder="e.g. anthropic"
          />
          <FilterField
            label="Status"
            value={filterInput.status}
            onChange={(v) => setFilterInput((f) => ({ ...f, status: v }))}
            placeholder="success / error"
          />
          <div className="flex gap-2">
            <button
              onClick={applyFilters}
              className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-sm rounded transition-colors"
            >
              Apply
            </button>
            <button
              onClick={clearFilters}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-sm rounded transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && <div className="bg-red-950 border border-red-800 rounded-lg p-3 text-red-300 text-sm">{error}</div>}

      {/* Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400 text-left">
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Input</th>
                <th className="px-4 py-2.5 font-medium text-right">Output</th>
                <th className="px-4 py-2.5 font-medium text-right">Cost</th>
                <th className="px-4 py-2.5 font-medium text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                    Loading...
                  </td>
                </tr>
              ) : data && data.items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                    No logs found.
                  </td>
                </tr>
              ) : (
                data?.items.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => navigate(`/logs/${item.id}`)}
                    className="border-b border-zinc-800/50 hover:bg-zinc-800/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 text-zinc-300 whitespace-nowrap">{formatTime(item.time_start)}</td>
                    <td className="px-4 py-2.5 text-zinc-300">{item.agent}</td>
                    <td className="px-4 py-2.5 text-zinc-400 font-mono text-xs">{item.model}</td>
                    <td className="px-4 py-2.5">
                      <span className={`font-medium ${statusColors[item.status] ?? "text-zinc-400"}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">
                      {formatTokens(item.input_tokens)}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">
                      {formatTokens(item.output_tokens)}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">{formatCost(item.cost)}</td>
                    <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">
                      {formatDuration(item.duration_ms)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.total > PAGE_SIZE && (
          <div className="border-t border-zinc-800 px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-zinc-500">
              {data.total} total &middot; Page {page + 1} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Prev
              </button>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function FilterField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-zinc-500 font-medium">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const form = e.currentTarget.closest("div.flex")
            const applyBtn = form?.querySelector("button")
            applyBtn?.click()
          }
        }}
        placeholder={placeholder}
        className="bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 w-40"
      />
    </div>
  )
}
