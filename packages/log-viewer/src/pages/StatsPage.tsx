import { useState, useEffect, useCallback } from "react"
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts"

interface StatsSummary {
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_reasoning_tokens: number
  total_cache_read_tokens: number
  total_cache_write_tokens: number
  total_cost: number
  avg_duration_ms: number
  avg_input_tokens: number
  avg_output_tokens: number
}

interface StatsGrouped {
  group: string
  request_count: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cost: number
  avg_duration_ms: number
}

interface StatsResult {
  summary: StatsSummary
  grouped: StatsGrouped[]
}

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16"]

function formatCost(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(4)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatTime(timestamp: string | number): string {
  const d = new Date(Number(timestamp))
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

async function fetchStats(params: Record<string, string>): Promise<StatsResult> {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`/api/logs/stats${qs ? `?${qs}` : ""}`)
  if (!res.ok) throw new Error(`Failed to fetch stats: ${res.status}`)
  return res.json()
}

function SummaryCards({ summary }: { summary: StatsSummary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      <div className="bg-zinc-800 rounded-lg p-4">
        <div className="text-zinc-400 text-sm">Total Requests</div>
        <div className="text-2xl font-bold text-white tabular-nums">{summary.total_requests.toLocaleString()}</div>
      </div>
      <div className="bg-zinc-800 rounded-lg p-4">
        <div className="text-zinc-400 text-sm">Total Tokens</div>
        <div className="text-2xl font-bold text-white tabular-nums">
          {formatTokens(summary.total_input_tokens + summary.total_output_tokens)}
        </div>
        <div className="text-xs text-zinc-500 mt-1">
          In: {formatTokens(summary.total_input_tokens)} / Out: {formatTokens(summary.total_output_tokens)}
        </div>
      </div>
      <div className="bg-zinc-800 rounded-lg p-4">
        <div className="text-zinc-400 text-sm">Total Cost</div>
        <div className="text-2xl font-bold text-white tabular-nums">{formatCost(summary.total_cost)}</div>
      </div>
      <div className="bg-zinc-800 rounded-lg p-4">
        <div className="text-zinc-400 text-sm">Avg Tokens/Request</div>
        <div className="text-2xl font-bold text-white tabular-nums">
          {formatTokens(summary.avg_input_tokens + summary.avg_output_tokens)}
        </div>
        <div className="text-xs text-zinc-500 mt-1">
          In: {formatTokens(summary.avg_input_tokens)} / Out: {formatTokens(summary.avg_output_tokens)}
        </div>
      </div>
    </div>
  )
}

function TimeRangeFilter({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-zinc-800 text-zinc-300 border border-zinc-700 rounded px-3 py-1.5 text-sm"
    >
      <option value="1h">Last 1 hour</option>
      <option value="6h">Last 6 hours</option>
      <option value="24h">Last 24 hours</option>
      <option value="7d">Last 7 days</option>
      <option value="30d">Last 30 days</option>
      <option value="all">All time</option>
    </select>
  )
}

function getTimeRange(range: string): { time_start?: string; group_by_time: "hour" | "day" } {
  const now = Date.now()
  const hour = 3600_000
  const day = 86400_000
  switch (range) {
    case "1h":
      return { time_start: String(now - hour), group_by_time: "hour" }
    case "6h":
      return { time_start: String(now - 6 * hour), group_by_time: "hour" }
    case "24h":
      return { time_start: String(now - 24 * hour), group_by_time: "hour" }
    case "7d":
      return { time_start: String(now - 7 * day), group_by_time: "day" }
    case "30d":
      return { time_start: String(now - 30 * day), group_by_time: "day" }
    default:
      return { group_by_time: "day" }
  }
}

function TokenTimeChart({ timeRange }: { timeRange: string }) {
  const [data, setData] = useState<StatsGrouped[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const { time_start, group_by_time } = getTimeRange(timeRange)
    const params: Record<string, string> = { group_by: group_by_time }
    if (time_start) params.time_start = time_start
    setLoading(true)
    fetchStats(params)
      .then((r) => setData(r.grouped.sort((a, b) => Number(a.group) - Number(b.group))))
      .finally(() => setLoading(false))
  }, [timeRange])

  if (loading) return <div className="text-zinc-500 py-8 text-center">Loading...</div>
  if (data.length === 0) return <div className="text-zinc-500 py-8 text-center">No data for this time range</div>

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
        <XAxis dataKey="group" tick={{ fill: "#a1a1aa", fontSize: 12 }} tickFormatter={formatTime} />
        <YAxis yAxisId="tokens" tick={{ fill: "#a1a1aa", fontSize: 12 }} tickFormatter={formatTokens} />
        <YAxis yAxisId="cost" orientation="right" tick={{ fill: "#a1a1aa", fontSize: 12 }} tickFormatter={(v) => formatCost(v)} />
        <Tooltip
          contentStyle={{ backgroundColor: "#27272a", border: "1px solid #3f3f46", borderRadius: 8 }}
          labelFormatter={(label) => formatTime(String(label))}
          formatter={(value, name) => {
            const v = Number(value)
            if (name === "cost") return [formatCost(v), "Cost"]
            return [formatTokens(v), String(name)]
          }}
        />
        <Legend />
        <Line yAxisId="tokens" type="monotone" dataKey="input_tokens" name="Input Tokens" stroke="#3b82f6" dot={false} />
        <Line yAxisId="tokens" type="monotone" dataKey="output_tokens" name="Output Tokens" stroke="#10b981" dot={false} />
        <Line yAxisId="cost" type="monotone" dataKey="cost" name="cost" stroke="#f59e0b" dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

function ModelBarChart({ timeRange }: { timeRange: string }) {
  const [data, setData] = useState<StatsGrouped[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const { time_start } = getTimeRange(timeRange)
    const params: Record<string, string> = { group_by: "model" }
    if (time_start) params.time_start = time_start
    setLoading(true)
    fetchStats(params)
      .then((r) => setData(r.grouped))
      .finally(() => setLoading(false))
  }, [timeRange])

  if (loading) return <div className="text-zinc-500 py-8 text-center">Loading...</div>
  if (data.length === 0) return <div className="text-zinc-500 py-8 text-center">No data for this time range</div>

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
        <XAxis dataKey="group" tick={{ fill: "#a1a1aa", fontSize: 11 }} angle={-20} textAnchor="end" height={60} />
        <YAxis tick={{ fill: "#a1a1aa", fontSize: 12 }} tickFormatter={formatTokens} />
        <Tooltip
          contentStyle={{ backgroundColor: "#27272a", border: "1px solid #3f3f46", borderRadius: 8 }}
          formatter={(value) => [formatTokens(Number(value)), ""]}
        />
        <Legend />
        <Bar dataKey="input_tokens" name="Input Tokens" fill="#3b82f6" />
        <Bar dataKey="output_tokens" name="Output Tokens" fill="#10b981" />
      </BarChart>
    </ResponsiveContainer>
  )
}

function AgentPieChart({ timeRange }: { timeRange: string }) {
  const [data, setData] = useState<StatsGrouped[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const { time_start } = getTimeRange(timeRange)
    const params: Record<string, string> = { group_by: "agent" }
    if (time_start) params.time_start = time_start
    setLoading(true)
    fetchStats(params)
      .then((r) => setData(r.grouped))
      .finally(() => setLoading(false))
  }, [timeRange])

  if (loading) return <div className="text-zinc-500 py-8 text-center">Loading...</div>
  if (data.length === 0) return <div className="text-zinc-500 py-8 text-center">No data for this time range</div>

  const pieData = data.map((d) => ({
    name: d.group,
    value: d.input_tokens + d.output_tokens,
  }))

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={pieData}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={100}
          label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
        >
          {pieData.map((_, i) => (
            <Cell key={i} fill={COLORS[i % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ backgroundColor: "#27272a", border: "1px solid #3f3f46", borderRadius: 8 }}
          formatter={(value) => [formatTokens(Number(value)), "Tokens"]}
        />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  )
}

function SessionTable({ timeRange }: { timeRange: string }) {
  const [data, setData] = useState<StatsGrouped[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const { time_start } = getTimeRange(timeRange)
    const params: Record<string, string> = { group_by: "session" }
    if (time_start) params.time_start = time_start
    setLoading(true)
    fetchStats(params)
      .then((r) => setData(r.grouped))
      .finally(() => setLoading(false))
  }, [timeRange])

  if (loading) return <div className="text-zinc-500 py-8 text-center">Loading...</div>
  if (data.length === 0) return <div className="text-zinc-500 py-8 text-center">No data for this time range</div>

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-700 text-zinc-400 text-left">
            <th className="py-2 pr-4">Session</th>
            <th className="py-2 pr-4 text-right">Requests</th>
            <th className="py-2 pr-4 text-right">Input Tokens</th>
            <th className="py-2 pr-4 text-right">Output Tokens</th>
            <th className="py-2 pr-4 text-right">Reasoning</th>
            <th className="py-2 pr-4 text-right">Cost</th>
            <th className="py-2 text-right">Avg Duration</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.group} className="border-b border-zinc-800 text-zinc-300 hover:bg-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs truncate max-w-[200px]" title={row.group}>
                {row.group.slice(0, 12)}...
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{row.request_count}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatTokens(row.input_tokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatTokens(row.output_tokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatTokens(row.reasoning_tokens)}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{formatCost(row.cost)}</td>
              <td className="py-2 text-right tabular-nums">{row.avg_duration_ms.toLocaleString()}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function StatsPage() {
  const [timeRange, setTimeRange] = useState("7d")
  const [summary, setSummary] = useState<StatsSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const loadSummary = useCallback(() => {
    const { time_start } = getTimeRange(timeRange)
    const params: Record<string, string> = {}
    if (time_start) params.time_start = time_start
    setLoading(true)
    fetchStats(params)
      .then((r) => setSummary(r.summary))
      .finally(() => setLoading(false))
  }, [timeRange])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Token Statistics</h2>
        <TimeRangeFilter value={timeRange} onChange={setTimeRange} />
      </div>

      {loading ? (
        <div className="text-zinc-500 py-8 text-center">Loading summary...</div>
      ) : summary ? (
        <SummaryCards summary={summary} />
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">Token Usage & Cost Over Time</h3>
          <TokenTimeChart timeRange={timeRange} />
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">Token Consumption by Model</h3>
          <ModelBarChart timeRange={timeRange} />
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">Token Distribution by Agent</h3>
          <AgentPieChart timeRange={timeRange} />
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-zinc-300 mb-4">Per-Session Token Totals</h3>
          <SessionTable timeRange={timeRange} />
        </div>
      </div>
    </div>
  )
}
