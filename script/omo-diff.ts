#!/usr/bin/env bun

/**
 * OMO Upstream Diff Reporting Tool
 *
 * Supports two sources:
 *   1. npm package (oh-my-opencode)
 *   2. git repo (oh-my-openagent)
 *
 * Dynamically scans all component directories (hooks, tools, agents, features,
 * config, plugin, mcp) instead of relying on hardcoded impact maps.
 *
 * Usage:
 *   bun run script/omo-diff.ts                          # from npm
 *   bun run script/omo-diff.ts --git                    # from git
 *   bun run script/omo-diff.ts --local /path/to/repo    # from local checkout
 *   bun run script/omo-diff.ts --update-baseline        # update baseline after review
 */

import path from "path"
import fs from "fs"
import os from "os"

// ─── Types ───────────────────────────────────────────────────────────

export type ComponentStatus = "internalized" | "skipped" | "deferred" | "partial" | "optional"

export type ComponentType = "tool" | "hook" | "agent" | "feature" | "config" | "plugin" | "mcp" | "dependency"

export interface Baseline {
  version: string
  date: string
  tools: Record<string, ComponentStatus>
  hooks: Record<string, ComponentStatus>
  agents: Record<string, ComponentStatus>
  features: Record<string, ComponentStatus>
  plugins: Record<string, ComponentStatus>
  mcp: Record<string, ComponentStatus>
  notes: string
}

export type ChangeCategory = "backport recommended" | "review needed" | "skip (diverged)"

export interface DiffChange {
  name: string
  type: ComponentType
  status: "new" | "modified" | "removed"
  category: ChangeCategory
  details: string
  affectedFiles: string[]
  omoFiles: string[]
}

export interface DiffReport {
  baselineVersion: string
  latestVersion: string
  date: string
  source: "npm" | "git" | "local"
  changes: DiffChange[]
  sections: Record<string, DiffChange[]>
}

// ─── Constants ──────────────────────────────────────────────────────

const OMO_NPM_PACKAGE = "oh-my-opencode"
const OMO_GIT_REPO = "https://github.com/code-yeongyu/oh-my-openagent.git"
const BASELINE_PATH = path.resolve(import.meta.dir, "../packages/opencode/.omo-baseline.json")
const REPORT_DIR = path.resolve(import.meta.dir, "../tasks")
const OPENCODE_SRC = path.resolve(import.meta.dir, "../packages/opencode/src")

const SKIP_ENTRIES = new Set(["index.ts", "index.js", "index.d.ts", "shared", "types.ts", "types.d.ts", "AGENTS.md"])
const SKIP_SUFFIXES = [".test.ts", ".test.js", ".d.ts"]

// Component type → directories to scan in OMO source
const COMPONENT_DIRS: Record<ComponentType, string[]> = {
  tool: ["tools"],
  hook: ["hooks"],
  agent: ["agents"],
  feature: ["features"],
  plugin: ["plugin"],
  mcp: ["mcp"],
  config: ["config"],
  dependency: [],
}

// ─── Baseline ───────────────────────────────────────────────────────

const BASELINE_DEFAULTS: Baseline = {
  version: "0.0.0",
  date: "",
  tools: {},
  hooks: {},
  agents: {},
  features: {},
  plugins: {},
  mcp: {},
  notes: "",
}

export function parseBaseline(raw: unknown): Baseline {
  if (!raw || typeof raw !== "object") return { ...BASELINE_DEFAULTS }
  const obj = raw as Record<string, unknown>
  const record = (key: string) =>
    (typeof obj[key] === "object" && obj[key] !== null ? obj[key] : {}) as Record<string, ComponentStatus>
  return {
    version: typeof obj.version === "string" ? obj.version : BASELINE_DEFAULTS.version,
    date: typeof obj.date === "string" ? obj.date : BASELINE_DEFAULTS.date,
    tools: record("tools"),
    hooks: record("hooks"),
    agents: record("agents"),
    features: record("features"),
    plugins: record("plugins"),
    mcp: record("mcp"),
    notes: typeof obj.notes === "string" ? obj.notes : BASELINE_DEFAULTS.notes,
  }
}

export function readBaseline(baselinePath: string): Baseline {
  if (!fs.existsSync(baselinePath)) return parseBaseline({})
  const raw = JSON.parse(fs.readFileSync(baselinePath, "utf-8"))
  return parseBaseline(raw)
}

export function writeBaseline(baselinePath: string, baseline: Baseline): void {
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n")
}

// ─── Source Fetching ────────────────────────────────────────────────

export async function fetchFromNpm(): Promise<{ version: string; packageDir: string }> {
  const response = await fetch(`https://registry.npmjs.org/${OMO_NPM_PACKAGE}/latest`)
  if (!response.ok) throw new Error(`npm registry error: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as Record<string, unknown>
  const version = data.version as string
  const dist = data.dist as Record<string, string>

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-diff-"))
  const tarballPath = path.join(tmpDir, "package.tgz")

  const dlResp = await fetch(dist.tarball)
  if (!dlResp.ok) throw new Error(`Failed to download tarball: ${dlResp.status}`)
  await Bun.write(tarballPath, await dlResp.arrayBuffer())

  const proc = Bun.spawn(["tar", "xzf", tarballPath, "-C", tmpDir], { stdout: "ignore", stderr: "pipe" })
  if ((await proc.exited) !== 0) {
    throw new Error(`Failed to extract tarball: ${await new Response(proc.stderr).text()}`)
  }

  return { version, packageDir: path.join(tmpDir, "package") }
}

export async function fetchFromGit(): Promise<{ version: string; packageDir: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-diff-git-"))
  const proc = Bun.spawn(["git", "clone", "--depth", "1", OMO_GIT_REPO, tmpDir], { stdout: "pipe", stderr: "pipe" })
  if ((await proc.exited) !== 0) {
    throw new Error(`Failed to clone repo: ${await new Response(proc.stderr).text()}`)
  }

  const pkgJson = path.join(tmpDir, "package.json")
  const version = fs.existsSync(pkgJson)
    ? (JSON.parse(fs.readFileSync(pkgJson, "utf-8")).version as string)
    : "git-HEAD"

  return { version, packageDir: tmpDir }
}

// ─── Dynamic Scanning ──────────────────────────────────────────────

function shouldSkip(name: string): boolean {
  if (SKIP_ENTRIES.has(name)) return true
  for (const suffix of SKIP_SUFFIXES) {
    if (name.endsWith(suffix)) return true
  }
  return false
}

function stripExt(name: string): string {
  return name.replace(/\.(ts|js|d\.ts)$/, "")
}

export interface ScannedComponent {
  name: string
  type: ComponentType
  isDirectory: boolean
  files: string[]
}

function scanDir(dir: string, type: ComponentType): ScannedComponent[] {
  if (!fs.existsSync(dir)) return []
  const results: ScannedComponent[] = []
  const seen = new Set<string>()

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue
    const name = entry.isDirectory() ? entry.name : stripExt(entry.name)
    if (seen.has(name)) continue
    seen.add(name)

    const files: string[] = []
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const child of fs.readdirSync(entryPath, { recursive: true })) {
        const childStr = String(child)
        if (childStr.endsWith(".ts") || childStr.endsWith(".js")) {
          if (!childStr.endsWith(".test.ts") && !childStr.endsWith(".test.js") && !childStr.endsWith(".d.ts")) {
            files.push(path.join(entryPath, childStr))
          }
        }
      }
    } else {
      files.push(entryPath)
    }

    results.push({ name, type, isDirectory: entry.isDirectory(), files })
  }

  return results
}

export interface ScanResult {
  components: ScannedComponent[]
  dependencies: Record<string, string>
}

export function scanPackage(packageDir: string): ScanResult {
  // Try src/ first (git clone), fall back to dist/ (npm)
  const srcDir = fs.existsSync(path.join(packageDir, "src"))
    ? path.join(packageDir, "src")
    : fs.existsSync(path.join(packageDir, "dist"))
      ? path.join(packageDir, "dist")
      : null

  const components: ScannedComponent[] = []

  if (srcDir) {
    for (const [type, dirs] of Object.entries(COMPONENT_DIRS) as [ComponentType, string[]][]) {
      for (const dir of dirs) {
        const fullDir = path.join(srcDir, dir)
        components.push(...scanDir(fullDir, type))
      }
    }
  }

  // Dependencies
  const dependencies: Record<string, string> = {}
  const pkgJson = path.join(packageDir, "package.json")
  if (fs.existsSync(pkgJson)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf-8"))
    if (pkg.dependencies) Object.assign(dependencies, pkg.dependencies)
    if (pkg.peerDependencies) Object.assign(dependencies, pkg.peerDependencies)
  }

  return { components, dependencies }
}

// ─── Affected File Discovery ────────────────────────────────────────

export function findAffectedFiles(name: string, type: ComponentType): string[] {
  const results: string[] = []
  const searchDirs: string[] = []

  if (type === "tool") searchDirs.push(path.join(OPENCODE_SRC, "tool"))
  if (type === "hook") searchDirs.push(path.join(OPENCODE_SRC, "session/hooks"))
  if (type === "agent") {
    searchDirs.push(path.join(OPENCODE_SRC, "agent"))
    searchDirs.push(path.join(OPENCODE_SRC, "agent/prompt"))
    searchDirs.push(path.join(OPENCODE_SRC, "agent/optional"))
  }
  if (type === "feature") {
    searchDirs.push(path.join(OPENCODE_SRC, "session"))
    searchDirs.push(path.join(OPENCODE_SRC, "tool"))
    searchDirs.push(path.join(OPENCODE_SRC, "mcp"))
  }
  if (type === "plugin") searchDirs.push(path.join(OPENCODE_SRC, "plugin"))
  if (type === "mcp") searchDirs.push(path.join(OPENCODE_SRC, "mcp"))
  if (type === "config") searchDirs.push(path.join(OPENCODE_SRC, "config"))
  if (type === "dependency") return ["packages/opencode/package.json"]

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir)) {
      const baseName = entry.replace(/\.(ts|js|txt)$/, "")
      // Exact match or direct prefix match (e.g. "lsp" matches "lsp-tools.ts")
      if (baseName === name || baseName.startsWith(name + "-") || baseName.startsWith(name + ".")) {
        const rel = path.relative(path.resolve(import.meta.dir, ".."), path.join(dir, entry))
        results.push(rel)
      }
    }
  }

  // Fallback: provide the expected path
  if (results.length === 0) {
    if (type === "tool") results.push(`packages/opencode/src/tool/${name}.ts`)
    if (type === "hook") results.push(`packages/opencode/src/session/hooks/`)
    if (type === "agent") results.push(`packages/opencode/src/agent/`)
    if (type === "feature") results.push(`packages/opencode/src/`)
    if (type === "plugin") results.push(`packages/opencode/src/plugin/`)
    if (type === "mcp") results.push(`packages/opencode/src/mcp/`)
  }

  return results
}

// ─── Diff Generation ────────────────────────────────────────────────

function getBaselineMap(baseline: Baseline, type: ComponentType): Record<string, ComponentStatus> {
  if (type === "tool") return baseline.tools
  if (type === "hook") return baseline.hooks
  if (type === "agent") return baseline.agents
  if (type === "feature") return baseline.features
  if (type === "plugin") return baseline.plugins
  if (type === "mcp") return baseline.mcp
  return {}
}

export function categorizeChange(name: string, type: ComponentType, status: "new" | "modified", baseline: Baseline): ChangeCategory {
  if (status === "new") return "backport recommended"
  const map = getBaselineMap(baseline, type)
  const current = map[name]
  if (current === "internalized" || current === "optional") return "review needed"
  if (current === "skipped") return "skip (diverged)"
  if (current === "deferred") return "review needed"
  return "review needed"
}

export function generateDiff(baseline: Baseline, scanned: ScanResult, latestVersion: string): DiffReport {
  const changes: DiffChange[] = []

  // Components
  for (const comp of scanned.components) {
    const map = getBaselineMap(baseline, comp.type)
    const status = map[comp.name] ? "modified" as const : "new" as const
    const omoFiles = comp.files.map((f) => path.relative(path.resolve(import.meta.dir, ".."), f))

    changes.push({
      name: comp.name,
      type: comp.type,
      status,
      category: categorizeChange(comp.name, comp.type, status, baseline),
      details:
        status === "new"
          ? `New ${comp.type} '${comp.name}' in OMO ${latestVersion} (${comp.files.length} files)`
          : `${comp.type} '${comp.name}' may have changes (${comp.files.length} files)`,
      affectedFiles: findAffectedFiles(comp.name, comp.type),
      omoFiles,
    })
  }

  // Check for removed components (in baseline but not in scanned)
  const scannedNames = new Map(scanned.components.map((c) => [`${c.type}:${c.name}`, c]))
  for (const [type, mapKey] of [
    ["tool", "tools"],
    ["hook", "hooks"],
    ["agent", "agents"],
    ["feature", "features"],
    ["plugin", "plugins"],
    ["mcp", "mcp"],
  ] as [ComponentType, keyof Baseline][]) {
    const map = baseline[mapKey]
    if (typeof map !== "object" || !map) continue
    for (const name of Object.keys(map as Record<string, unknown>)) {
      if (!scannedNames.has(`${type}:${name}`)) {
        changes.push({
          name,
          type,
          status: "removed",
          category: "review needed",
          details: `${type} '${name}' was in baseline but not found in OMO ${latestVersion}`,
          affectedFiles: findAffectedFiles(name, type),
          omoFiles: [],
        })
      }
    }
  }

  // Dependencies
  for (const [dep, version] of Object.entries(scanned.dependencies)) {
    changes.push({
      name: dep,
      type: "dependency",
      status: "modified",
      category: "review needed",
      details: `Dependency '${dep}@${version}'`,
      affectedFiles: ["packages/opencode/package.json"],
      omoFiles: [],
    })
  }

  // Build sections
  const sections: Record<string, DiffChange[]> = {}
  for (const change of changes) {
    const key = change.type
    if (!sections[key]) sections[key] = []
    sections[key]!.push(change)
  }

  return {
    baselineVersion: baseline.version,
    latestVersion,
    date: new Date().toISOString().split("T")[0]!,
    source: "npm",
    changes,
    sections,
  }
}

// ─── Report Formatting ─────────────────────────────────────────────

const SECTION_TITLES: Record<string, string> = {
  tool: "Tools",
  hook: "Hooks",
  agent: "Agents",
  feature: "Features",
  plugin: "Plugin System",
  mcp: "MCP",
  config: "Config",
  dependency: "Dependencies",
}

export function formatReport(report: DiffReport): string {
  const lines: string[] = []

  lines.push(`# OMO Upstream Diff Report`)
  lines.push("")
  lines.push(`- **Baseline version:** ${report.baselineVersion}`)
  lines.push(`- **Latest version:** ${report.latestVersion}`)
  lines.push(`- **Source:** ${report.source}`)
  lines.push(`- **Date:** ${report.date}`)
  lines.push("")

  if (report.changes.length === 0) {
    lines.push("## No Changes Detected")
    lines.push("")
    lines.push("The latest OMO version matches the baseline. No action required.")
    return lines.join("\n")
  }

  // Summary
  const newCount = report.changes.filter((c) => c.status === "new").length
  const modCount = report.changes.filter((c) => c.status === "modified").length
  const remCount = report.changes.filter((c) => c.status === "removed").length
  const backportCount = report.changes.filter((c) => c.category === "backport recommended").length
  const reviewCount = report.changes.filter((c) => c.category === "review needed").length
  const skipCount = report.changes.filter((c) => c.category === "skip (diverged)").length

  lines.push(`## Summary`)
  lines.push("")
  lines.push(`Total components: ${report.changes.length}`)
  lines.push(`- New: ${newCount}`)
  lines.push(`- Modified: ${modCount}`)
  lines.push(`- Removed: ${remCount}`)
  lines.push("")
  lines.push(`By category:`)
  lines.push(`- Backport recommended: ${backportCount}`)
  lines.push(`- Review needed: ${reviewCount}`)
  lines.push(`- Skip (diverged): ${skipCount}`)
  lines.push("")

  // Sections
  for (const [type, title] of Object.entries(SECTION_TITLES)) {
    const items = report.sections[type]
    if (!items || items.length === 0) continue

    lines.push(`## ${title}`)
    lines.push("")
    lines.push("| Name | Status | Category | Files | Details |")
    lines.push("|------|--------|----------|-------|---------|")
    for (const item of items) {
      const fileCount = item.omoFiles.length
      lines.push(
        `| ${item.name} | ${item.status} | ${item.category} | ${fileCount} | ${item.details} |`,
      )
    }
    lines.push("")

    // New components get extra detail
    const newItems = items.filter((i) => i.status === "new")
    if (newItems.length > 0) {
      lines.push("### New Components")
      lines.push("")
      for (const item of newItems) {
        lines.push(`**${item.name}** (${item.type}):`)
        if (item.omoFiles.length > 0) {
          lines.push("OMO source files:")
          for (const f of item.omoFiles.slice(0, 10)) {
            lines.push(`- \`${f}\``)
          }
          if (item.omoFiles.length > 10) lines.push(`- ... and ${item.omoFiles.length - 10} more`)
        }
        if (item.affectedFiles.length > 0) {
          lines.push("Potential target in OpenCode:")
          for (const f of item.affectedFiles) {
            lines.push(`- \`${f}\``)
          }
        }
        lines.push("")
      }
    }

    // Modified internalized components
    const reviewItems = items.filter((i) => i.status === "modified" && i.category === "review needed")
    if (reviewItems.length > 0) {
      lines.push("### Review Needed")
      lines.push("")
      for (const item of reviewItems) {
        lines.push(`**${item.name}:**`)
        for (const f of item.affectedFiles) {
          lines.push(`- \`${f}\``)
        }
        lines.push("")
      }
    }
  }

  return lines.join("\n")
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const updateBaseline = args.includes("--update-baseline")
  const useGit = args.includes("--git")
  const localIdx = args.indexOf("--local")
  const localPath = localIdx !== -1 ? args[localIdx + 1] : undefined

  const baseline = readBaseline(BASELINE_PATH)
  console.log(`Baseline version: ${baseline.version}`)

  let version: string
  let packageDir: string
  let source: "npm" | "git" | "local"

  if (localPath) {
    console.log(`Using local checkout: ${localPath}`)
    packageDir = path.resolve(localPath)
    const pkgJson = path.join(packageDir, "package.json")
    version = fs.existsSync(pkgJson)
      ? (JSON.parse(fs.readFileSync(pkgJson, "utf-8")).version as string)
      : "local"
    source = "local"
  } else if (useGit) {
    console.log(`Cloning from git: ${OMO_GIT_REPO}`)
    const result = await fetchFromGit()
    version = result.version
    packageDir = result.packageDir
    source = "git"
  } else {
    console.log(`Fetching from npm: ${OMO_NPM_PACKAGE}`)
    const result = await fetchFromNpm()
    version = result.version
    packageDir = result.packageDir
    source = "npm"
  }

  console.log(`Target version: ${version}`)

  if (version === baseline.version && source !== "local") {
    console.log("\nNo version change detected. Generating report anyway...")
  }

  console.log(`\nScanning ${packageDir}...`)
  const scanned = scanPackage(packageDir)
  const typeCounts = new Map<string, number>()
  for (const comp of scanned.components) {
    typeCounts.set(comp.type, (typeCounts.get(comp.type) ?? 0) + 1)
  }
  console.log(
    `Found: ${[...typeCounts.entries()].map(([t, c]) => `${c} ${t}s`).join(", ")}`,
  )

  const report = generateDiff(baseline, scanned, version)
  report.source = source
  const markdown = formatReport(report)

  const reportPath = path.join(REPORT_DIR, `omo-diff-report-${version}.md`)
  fs.mkdirSync(REPORT_DIR, { recursive: true })
  fs.writeFileSync(reportPath, markdown + "\n")
  console.log(`\nReport written to: ${reportPath}`)

  // Print quick summary
  const newItems = report.changes.filter((c) => c.status === "new")
  if (newItems.length > 0) {
    console.log(`\n🆕 New components (${newItems.length}):`)
    for (const item of newItems) {
      console.log(`  [${item.type}] ${item.name}`)
    }
  }

  if (updateBaseline) {
    baseline.version = version
    baseline.date = new Date().toISOString().split("T")[0]!
    writeBaseline(BASELINE_PATH, baseline)
    console.log(`\nBaseline updated to version ${version}`)
  }

  // Cleanup temp dir (but not if --local)
  if (!localPath && packageDir.includes(os.tmpdir())) {
    fs.rmSync(source === "git" ? packageDir : path.dirname(packageDir), { recursive: true, force: true })
  }

  console.log("\nDone!")
  process.exit(0)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err.message)
    process.exit(1)
  })
}
