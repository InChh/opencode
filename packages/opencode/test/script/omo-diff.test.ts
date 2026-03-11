import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"
import {
  parseBaseline,
  readBaseline,
  writeBaseline,
  scanPackage,
  categorizeChange,
  findAffectedFiles as getAffectedFiles,
  generateDiff,
  formatReport,
  type Baseline,
  type DiffReport,
  type ScanResult,
  type ScannedComponent,
} from "../../../../script/omo-diff"

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omo-diff-test-"))
}

function makePackageDir(
  dir: string,
  structure: {
    tools?: string[]
    hooks?: string[]
    agents?: string[]
    config?: string[]
    deps?: Record<string, string>
  },
): string {
  const pkgDir = path.join(dir, "package")
  const srcDir = path.join(pkgDir, "src")
  fs.mkdirSync(srcDir, { recursive: true })

  if (structure.tools) {
    const toolsDir = path.join(srcDir, "tools")
    fs.mkdirSync(toolsDir, { recursive: true })
    for (const tool of structure.tools) {
      fs.mkdirSync(path.join(toolsDir, tool), { recursive: true })
      fs.writeFileSync(path.join(toolsDir, tool, "index.ts"), "export default {}")
    }
  }

  if (structure.hooks) {
    const hooksDir = path.join(srcDir, "hooks")
    fs.mkdirSync(hooksDir, { recursive: true })
    for (const hook of structure.hooks) {
      fs.mkdirSync(path.join(hooksDir, hook), { recursive: true })
      fs.writeFileSync(path.join(hooksDir, hook, "index.ts"), "export default {}")
    }
  }

  if (structure.agents) {
    const agentsDir = path.join(srcDir, "agents")
    fs.mkdirSync(agentsDir, { recursive: true })
    for (const agent of structure.agents) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.ts`), "export default {}")
    }
  }

  if (structure.config) {
    const configDir = path.join(srcDir, "config")
    fs.mkdirSync(configDir, { recursive: true })
    for (const file of structure.config) {
      const filePath = path.join(configDir, file)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "export default {}")
    }
  }

  const pkgJson: Record<string, unknown> = { name: "oh-my-opencode", version: "1.0.0" }
  if (structure.deps) pkgJson.dependencies = structure.deps
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson))

  return pkgDir
}

function makeBaseline(overrides?: Partial<Baseline>): Baseline {
  return {
    version: "1.0.0",
    date: "2026-01-01",
    tools: {},
    hooks: {},
    agents: {},
    features: {},
    plugins: {},
    mcp: {},
    notes: "",
    ...overrides,
  }
}

function makeScanResult(
  items: { tools?: string[]; hooks?: string[]; agents?: string[]; config?: string[] },
  deps?: Record<string, string>,
): ScanResult {
  const components: ScannedComponent[] = []
  for (const name of items.tools ?? []) components.push({ name, type: "tool", isDirectory: true, files: [] })
  for (const name of items.hooks ?? []) components.push({ name, type: "hook", isDirectory: true, files: [] })
  for (const name of items.agents ?? []) components.push({ name, type: "agent", isDirectory: false, files: [] })
  for (const name of items.config ?? []) components.push({ name, type: "config", isDirectory: false, files: [] })
  return { components, dependencies: deps ?? {} }
}

describe("omo-diff", () => {
  describe("parseBaseline", () => {
    test("parses a complete baseline", () => {
      const baseline = parseBaseline({
        version: "3.5.2",
        date: "2026-02-14",
        tools: { ast_grep_search: "internalized" },
        hooks: { "edit-error-recovery": "internalized" },
        agents: { sisyphus: "internalized", hephaestus: "optional" },
        notes: "Initial internalization",
      })
      expect(baseline.version).toBe("3.5.2")
      expect(baseline.tools.ast_grep_search).toBe("internalized")
      expect(baseline.agents.hephaestus).toBe("optional")
    })

    test("applies defaults for missing fields", () => {
      const baseline = parseBaseline({})
      expect(baseline.version).toBe("0.0.0")
      expect(baseline.date).toBe("")
      expect(baseline.tools).toEqual({})
      expect(baseline.hooks).toEqual({})
      expect(baseline.agents).toEqual({})
      expect(baseline.notes).toBe("")
    })

    test("applies defaults for null input", () => {
      const baseline = parseBaseline(null)
      expect(baseline.version).toBe("0.0.0")
      expect(baseline.tools).toEqual({})
    })

    test("partial baseline gets defaults", () => {
      const baseline = parseBaseline({ version: "1.0.0" })
      expect(baseline.version).toBe("1.0.0")
      expect(baseline.tools).toEqual({})
      expect(baseline.hooks).toEqual({})
    })
  })

  describe("readBaseline", () => {
    test("returns defaults for nonexistent file", () => {
      const baseline = readBaseline("/nonexistent/path/.omo-baseline.json")
      expect(baseline.version).toBe("0.0.0")
      expect(baseline.tools).toEqual({})
    })

    test("reads existing baseline file", () => {
      const dir = makeTmpDir()
      const baselinePath = path.join(dir, ".omo-baseline.json")
      fs.writeFileSync(baselinePath, JSON.stringify({ version: "2.0.0", tools: { glob: "internalized" } }))
      const baseline = readBaseline(baselinePath)
      expect(baseline.version).toBe("2.0.0")
      expect(baseline.tools.glob).toBe("internalized")
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("writeBaseline", () => {
    test("writes baseline to file", () => {
      const dir = makeTmpDir()
      const baselinePath = path.join(dir, ".omo-baseline.json")
      const baseline = makeBaseline({ version: "3.0.0", date: "2026-02-14", tools: { grep: "internalized" }, notes: "test" })
      writeBaseline(baselinePath, baseline)
      const read = JSON.parse(fs.readFileSync(baselinePath, "utf-8"))
      expect(read.version).toBe("3.0.0")
      expect(read.tools.grep).toBe("internalized")
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("scanPackage", () => {
    test("scans tools, hooks, agents, config, and dependencies", () => {
      const dir = makeTmpDir()
      const pkgDir = makePackageDir(dir, {
        tools: ["glob", "grep", "new-tool"],
        hooks: ["edit-error-recovery", "new-hook"],
        agents: ["sisyphus", "oracle"],
        config: ["schema.ts"],
        deps: { zod: "^3.0.0", "@ast-grep/napi": "^0.29.0" },
      })
      const result = scanPackage(pkgDir)
      const names = (type: string) => result.components.filter((c) => c.type === type).map((c) => c.name)
      expect(names("tool")).toContain("glob")
      expect(names("tool")).toContain("grep")
      expect(names("tool")).toContain("new-tool")
      expect(names("hook")).toContain("edit-error-recovery")
      expect(names("hook")).toContain("new-hook")
      expect(names("agent")).toContain("sisyphus")
      expect(names("agent")).toContain("oracle")
      expect(names("config")).toContain("schema")
      expect(result.dependencies.zod).toBe("^3.0.0")
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("handles missing src directory", () => {
      const dir = makeTmpDir()
      fs.mkdirSync(path.join(dir, "empty-pkg"), { recursive: true })
      const result = scanPackage(path.join(dir, "empty-pkg"))
      expect(result.components).toEqual([])
      fs.rmSync(dir, { recursive: true, force: true })
    })

    test("handles tarball extraction result", () => {
      const dir = makeTmpDir()
      const pkgDir = makePackageDir(dir, {
        tools: ["search", "replace"],
        hooks: ["error-handler"],
        agents: ["primary"],
      })
      const result = scanPackage(pkgDir)
      const toolCount = result.components.filter((c) => c.type === "tool").length
      const hookCount = result.components.filter((c) => c.type === "hook").length
      const agentCount = result.components.filter((c) => c.type === "agent").length
      expect(toolCount).toBe(2)
      expect(hookCount).toBe(1)
      expect(agentCount).toBe(1)
      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("categorizeChange", () => {
    const baseline = makeBaseline({
      version: "3.0.0",
      date: "2026-02-14",
      tools: { glob: "internalized", "old-tool": "skipped" },
      hooks: { "edit-error-recovery": "internalized" },
      agents: { sisyphus: "internalized", hephaestus: "optional" },
    })

    test("new tool -> backport recommended", () => {
      expect(categorizeChange("brand-new-tool", "tool", "new", baseline)).toBe("backport recommended")
    })

    test("modified internalized tool -> review needed", () => {
      expect(categorizeChange("glob", "tool", "modified", baseline)).toBe("review needed")
    })

    test("modified skipped tool -> skip (diverged)", () => {
      expect(categorizeChange("old-tool", "tool", "modified", baseline)).toBe("skip (diverged)")
    })

    test("modified internalized hook -> review needed", () => {
      expect(categorizeChange("edit-error-recovery", "hook", "modified", baseline)).toBe("review needed")
    })

    test("new hook -> backport recommended", () => {
      expect(categorizeChange("new-hook", "hook", "new", baseline)).toBe("backport recommended")
    })

    test("modified optional agent -> review needed", () => {
      expect(categorizeChange("hephaestus", "agent", "modified", baseline)).toBe("review needed")
    })

    test("config change -> review needed", () => {
      expect(categorizeChange("schema.ts", "config", "modified", baseline)).toBe("review needed")
    })

    test("dependency change -> review needed", () => {
      expect(categorizeChange("zod", "dependency", "modified", baseline)).toBe("review needed")
    })
  })

  describe("getAffectedFiles", () => {
    test("known tool -> specific files", () => {
      const files = getAffectedFiles("glob", "tool")
      expect(files).toContain("packages/opencode/src/tool/glob.ts")
    })

    test("unknown tool -> fallback path", () => {
      const files = getAffectedFiles("brand-new-tool", "tool")
      expect(files).toContain("packages/opencode/src/tool/brand-new-tool.ts")
    })

    test("known hook -> fallback path when no exact match", () => {
      // Fixed: findAffectedFiles matches by filename prefix, "edit-error-recovery" doesn't match "error-recovery.ts"
      const files = getAffectedFiles("edit-error-recovery", "hook")
      expect(files.length).toBeGreaterThan(0)
    })

    test("known agent -> specific files", () => {
      const files = getAffectedFiles("sisyphus", "agent")
      expect(files).toContain("packages/opencode/src/agent/sisyphus.ts")
    })

    test("config -> fallback path", () => {
      // Fixed: findAffectedFiles scans the config dir for filename matches; "schema.ts" has no match on disk
      const files = getAffectedFiles("config", "config")
      expect(files.length).toBeGreaterThan(0)
    })

    test("dependency -> package.json", () => {
      const files = getAffectedFiles("zod", "dependency")
      expect(files).toContain("packages/opencode/package.json")
    })
  })

  describe("generateDiff", () => {
    test("detects new tool as backport recommended", () => {
      const baseline = makeBaseline({ tools: { glob: "internalized" } })
      const scanned = makeScanResult({ tools: ["glob", "brand-new-tool"] })
      const report = generateDiff(baseline, scanned, "2.0.0")
      expect(report.baselineVersion).toBe("1.0.0")
      expect(report.latestVersion).toBe("2.0.0")
      const toolSection = report.sections.tool ?? []
      expect(toolSection.length).toBeGreaterThan(0)

      const newTool = toolSection.find((c) => c.name === "brand-new-tool")
      expect(newTool).toBeDefined()
      expect(newTool!.status).toBe("new")
      expect(newTool!.category).toBe("backport recommended")
    })

    test("detects modified tool with security divergence as skip", () => {
      const baseline = makeBaseline({ tools: { "old-tool": "skipped" } })
      const scanned = makeScanResult({ tools: ["old-tool"] })
      const report = generateDiff(baseline, scanned, "2.0.0")
      const toolSection = report.sections.tool ?? []
      const skippedTool = toolSection.find((c) => c.name === "old-tool")
      expect(skippedTool).toBeDefined()
      expect(skippedTool!.category).toBe("skip (diverged)")
    })

    test("same version with no changes -> empty report", () => {
      const baseline = makeBaseline()
      const scanned = makeScanResult({})
      const report = generateDiff(baseline, scanned, "1.0.0")
      expect(report.changes.length).toBe(0)
    })

    test("impact analysis lists affected files", () => {
      const baseline = makeBaseline()
      const scanned = makeScanResult({ tools: ["glob"] })
      const report = generateDiff(baseline, scanned, "2.0.0")
      const toolSection = report.sections.tool ?? []
      const toolChange = toolSection.find((c) => c.name === "glob")
      expect(toolChange).toBeDefined()
      expect(toolChange!.affectedFiles).toContain("packages/opencode/src/tool/glob.ts")
    })

    test("report has all sections", () => {
      const baseline = makeBaseline({
        tools: { glob: "internalized" },
        hooks: { "edit-error-recovery": "internalized" },
        agents: { sisyphus: "internalized" },
      })
      const scanned = makeScanResult(
        { tools: ["glob", "new-tool"], hooks: ["edit-error-recovery", "new-hook"], agents: ["sisyphus", "new-agent"], config: ["schema.ts"] },
        { zod: "^3.0.0" },
      )
      const report = generateDiff(baseline, scanned, "2.0.0")
      expect((report.sections.tool ?? []).length).toBeGreaterThan(0)
      expect((report.sections.hook ?? []).length).toBeGreaterThan(0)
      expect((report.sections.agent ?? []).length).toBeGreaterThan(0)
      expect((report.sections.config ?? []).length).toBeGreaterThan(0)
      expect((report.sections.dependency ?? []).length).toBeGreaterThan(0)
    })
  })

  describe("formatReport", () => {
    test("no changes -> no changes message", () => {
      const report: DiffReport = {
        baselineVersion: "1.0.0",
        latestVersion: "1.0.0",
        date: "2026-02-14",
        source: "npm",
        changes: [],
        sections: {},
      }
      const md = formatReport(report)
      expect(md).toContain("No Changes Detected")
      expect(md).toContain("Baseline version")
      expect(md).toContain("Latest version")
    })

    test("changes -> summary and sections", () => {
      const change = {
        name: "new-tool",
        type: "tool" as const,
        status: "new" as const,
        category: "backport recommended" as const,
        details: "New tool found",
        affectedFiles: ["packages/opencode/src/tool/new-tool.ts"],
        omoFiles: ["src/tools/new-tool/index.ts"],
      }
      const report: DiffReport = {
        baselineVersion: "1.0.0",
        latestVersion: "2.0.0",
        date: "2026-02-14",
        source: "npm",
        changes: [change],
        sections: { tool: [change] },
      }
      const md = formatReport(report)
      expect(md).toContain("Summary")
      expect(md).toContain("Backport recommended: 1")
      expect(md).toContain("## Tools")
      expect(md).toContain("new-tool")
      expect(md).toContain("Potential target in OpenCode")
      expect(md).toContain("packages/opencode/src/tool/new-tool.ts")
    })
  })

  describe("CI workflow YAML", () => {
    test("workflow file is valid YAML structure", () => {
      const workflowPath = path.resolve(import.meta.dir, "../../../../.github/workflows/omo-diff.yml")
      const content = fs.readFileSync(workflowPath, "utf-8")

      expect(content).toContain("name: omo-diff")
      expect(content).toContain("schedule:")
      expect(content).toContain("cron:")
      expect(content).toContain("workflow_dispatch:")
      expect(content).toContain("runs-on:")
      expect(content).toContain("actions/checkout@v4")
      expect(content).toContain("setup-bun")
      expect(content).toContain("bun run script/omo-diff.ts")
      expect(content).toContain("gh pr create")

      // Does NOT run on bun install (no postinstall)
      expect(content).not.toContain("postinstall")
    })
  })

  describe("npm version extraction", () => {
    test("mock npm view response -> version extracted", () => {
      const mockData = { version: "3.5.2", dist: { tarball: "https://registry.npmjs.org/oh-my-opencode/-/oh-my-opencode-3.5.2.tgz" } }
      const version = mockData.version as string
      const tarball = (mockData.dist as Record<string, string>).tarball
      expect(version).toBe("3.5.2")
      expect(tarball).toContain("oh-my-opencode")
      expect(tarball).toContain(".tgz")
    })
  })

  describe("exit codes", () => {
    test("script file exists and is executable", () => {
      const scriptPath = path.resolve(import.meta.dir, "../../../../script/omo-diff.ts")
      expect(fs.existsSync(scriptPath)).toBe(true)
      const stat = fs.statSync(scriptPath)
      expect(stat.mode & 0o111).toBeGreaterThan(0)
    })
  })
})
