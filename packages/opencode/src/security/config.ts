import { SecuritySchema } from "./schema"
import { Log } from "../util/log"
import path from "path"
import fs from "fs"
import crypto from "crypto"

export namespace SecurityConfig {
  const log = Log.create({ service: "security-config" })

  const SECURITY_CONFIG_FILE = ".opencode-security.json"
  const DISK_CACHE_FILE = ".opencode/security-cache.json"
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache"])

  const emptyConfig: SecuritySchema.ResolvedSecurityConfig = {
    version: "1.0",
    roles: [],
    rules: [],
    resolvedAllowlist: [],
  }

  // --- Scoped config storage ---

  export interface ScopedConfig {
    config: SecuritySchema.SecurityConfig
    path: string
    scopeDir: string
  }

  let scopedConfigs: ScopedConfig[] = []
  let projectRootDir: string = ""
  let configLoaded = false

  // --- In-memory scan cache ---

  let scanCache: { root: string; configs: ScopedConfig[] } | null = null

  // --- In-memory resolveForPath cache ---

  const resolveCache = new Map<string, SecuritySchema.ResolvedSecurityConfig>()

  // --- Disk cache types ---

  interface DiskCacheEntry {
    configPath: string
    scopeDir: string
    mtimeMs: number
    contentHash: string
    config: SecuritySchema.SecurityConfig
  }

  interface DiskCache {
    version: 1
    scanRoot: string
    entries: DiskCacheEntry[]
  }

  // --- Loading ---

  export async function loadSecurityConfig(projectRoot: string): Promise<SecuritySchema.ResolvedSecurityConfig> {
    projectRootDir = path.resolve(projectRoot)
    const gitRoot = findGitRoot(projectRootDir)
    const scanRoot = gitRoot ?? projectRootDir

    // Invalidate caches on explicit reload so new file contents are picked up
    scanCache = null
    resolveCache.clear()
    // Scan from git root (or project root) downward, with disk + memory cache
    scopedConfigs = await scanAllConfigs(scanRoot)

    if (scopedConfigs.length === 0) {
      log.debug("no security configs found, using empty config", { projectRoot })
      configLoaded = true
      return emptyConfig
    }

    log.info("security configs loaded", {
      count: scopedConfigs.length,
      paths: scopedConfigs.map((c) => c.path),
    })

    configLoaded = true
    return resolveForPath(projectRootDir)
  }

  /**
   * Scan all `.opencode-security.json` from a root directory downward.
   * Uses a two-layer cache:
   * 1. In-memory cache (scanCache) — survives within the same process
   * 2. Disk cache (.opencode/security-cache.json) — survives across restarts
   *
   * Disk cache stores {path, mtime, contentHash, config} per config file.
   * On startup, walks the tree to find config file paths + mtimes, then
   * compares against disk cache. Only re-parses files that changed.
   */
  async function scanAllConfigs(root: string): Promise<ScopedConfig[]> {
    const resolved = path.resolve(root)
    if (scanCache?.root === resolved) return scanCache.configs

    const diskCache = loadDiskCache(resolved)
    const diskMap = new Map<string, DiskCacheEntry>()
    if (diskCache) {
      for (const entry of diskCache.entries) {
        diskMap.set(entry.configPath, entry)
      }
    }

    // Phase 1: Walk tree to find config file paths + mtimes (fast — no file reads)
    const found: { configPath: string; scopeDir: string; mtimeMs: number }[] = []
    walkForConfigPaths(resolved, found)

    // Phase 2: For each found config, check disk cache; re-parse only if changed
    const results: ScopedConfig[] = []
    let cacheHits = 0
    let cacheMisses = 0

    for (const { configPath, scopeDir, mtimeMs } of found) {
      const cached = diskMap.get(configPath)
      if (cached && cached.mtimeMs === mtimeMs) {
        // mtime matches — trust the cached config
        results.push({ config: cached.config, path: configPath, scopeDir })
        cacheHits++
        continue
      }

      // Cache miss — read and parse the file
      const config = await loadConfigFile(configPath)
      if (config) {
        results.push({ config, path: configPath, scopeDir })
      }
      cacheMisses++
    }

    // Sort by depth: shallowest (root) first, deepest last
    results.sort((a, b) => a.scopeDir.length - b.scopeDir.length)

    scanCache = { root: resolved, configs: results }

    // Write disk cache if anything changed
    if (cacheMisses > 0 || !diskCache || found.length !== diskCache.entries.length) {
      writeDiskCache(resolved, results)
    }

    if (cacheHits > 0 || cacheMisses > 0) {
      log.debug("security config scan complete", { cacheHits, cacheMisses, total: found.length })
    }

    return results
  }

  /**
   * Walk the directory tree collecting config file paths and mtimes.
   * Does NOT read file contents — only stat for mtime.
   */
  function walkForConfigPaths(
    dir: string,
    out: { configPath: string; scopeDir: string; mtimeMs: number }[],
  ) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        walkForConfigPaths(path.join(dir, entry.name), out)
      } else if (entry.name === SECURITY_CONFIG_FILE) {
        const configPath = path.join(dir, entry.name)
        const stat = fs.statSync(configPath, { throwIfNoEntry: false })
        if (stat) {
          out.push({ configPath, scopeDir: dir, mtimeMs: stat.mtimeMs })
        }
      }
    }
  }

  // --- Disk cache I/O ---

  function diskCachePath(scanRoot: string): string {
    // Store in the project's .opencode/ directory
    return path.join(projectRootDir || scanRoot, DISK_CACHE_FILE)
  }

  function loadDiskCache(scanRoot: string): DiskCache | null {
    const cachePath = diskCachePath(scanRoot)
    try {
      const text = fs.readFileSync(cachePath, "utf8")
      const parsed = JSON.parse(text) as DiskCache
      if (parsed.version !== 1 || parsed.scanRoot !== scanRoot) return null
      return parsed
    } catch {
      return null
    }
  }

  function writeDiskCache(scanRoot: string, configs: ScopedConfig[]) {
    const cachePath = diskCachePath(scanRoot)
    const entries: DiskCacheEntry[] = configs.map((sc) => {
      const stat = fs.statSync(sc.path, { throwIfNoEntry: false })
      const content = fs.readFileSync(sc.path, "utf8")
      return {
        configPath: sc.path,
        scopeDir: sc.scopeDir,
        mtimeMs: stat?.mtimeMs ?? 0,
        contentHash: crypto.createHash("md5").update(content).digest("hex"),
        config: sc.config,
      }
    })

    const cache: DiskCache = { version: 1, scanRoot, entries }
    try {
      const dir = path.dirname(cachePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(cachePath, JSON.stringify(cache), "utf8")
    } catch (err) {
      log.debug("failed to write security disk cache", { error: (err as Error).message })
    }
  }

  /**
   * Resolve the effective security config for a given file/directory path.
   *
   * Finds all configs whose scope is an ancestor of (or equals) the path,
   * then merges with child-overrides-parent semantics:
   * - rules: child replaces parent (if child defines rules)
   * - allowlist: child replaces parent (if child defines allowlist)
   * - roles: union across all (must be consistent)
   * - mcp: most restrictive wins
   * - segments, logging, auth: most specific (deepest) wins
   *
   * Patterns with `../` that escape the config's scope are filtered out.
   */
  export function resolveForPath(filePath: string): SecuritySchema.ResolvedSecurityConfig {
    // Resolve relative paths against projectRootDir (not CWD) so that
    // checkAccess("secrets/key.pem", ...) works correctly when config is
    // loaded from a different directory than CWD.
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectRootDir || process.cwd(), filePath)

    // Check in-memory resolve cache
    const cached = resolveCache.get(resolved)
    if (cached) return cached

    // Find all configs whose scope contains this path (ancestors + exact match)
    const applicable = scopedConfigs.filter((c) => {
      return resolved === c.scopeDir || resolved.startsWith(c.scopeDir + "/")
    })

    if (applicable.length === 0) return emptyConfig

    // Sorted shallowest-first (from scanAllConfigs), so last = most specific

    // --- Roles: union across all (must be consistent) ---
    const roleMap = new Map<string, number>()
    for (const { config, path: configPath } of applicable) {
      for (const role of config.roles ?? []) {
        const existing = roleMap.get(role.name)
        if (existing !== undefined && existing !== role.level) {
          log.error("role conflict across configs", {
            role: role.name,
            existingLevel: existing,
            newLevel: role.level,
            configPath,
          })
        }
        roleMap.set(role.name, role.level)
      }
    }
    const mergedRoles: SecuritySchema.Role[] = [...roleMap.entries()].map(([name, level]) => ({ name, level }))

    // --- Rules: child overrides parent (last defined wins) ---
    // Scope-filter: remove patterns that escape their config's scope via ../
    let mergedRules: SecuritySchema.Rule[] | undefined
    for (const sc of applicable) {
      if (sc.config.rules !== undefined) {
        mergedRules = filterScopedRules(sc.config.rules, sc.scopeDir)
      }
    }

    // --- Allowlist: child overrides parent (last defined wins) ---
    let resolvedAllowlist: SecuritySchema.AllowlistLayer[] = []
    for (const sc of applicable) {
      if (sc.config.allowlist !== undefined) {
        const filtered = filterScopedAllowlist(sc.config.allowlist, sc.scopeDir)
        resolvedAllowlist = [{ source: sc.path, entries: filtered }]
      }
    }

    // --- Segments: most specific wins ---
    let mergedSegments: SecuritySchema.Segments | undefined
    for (const sc of applicable) {
      if (sc.config.segments !== undefined) {
        mergedSegments = sc.config.segments
      }
    }

    // --- Logging: most specific wins ---
    let mergedLogging: SecuritySchema.Logging | undefined
    for (const sc of applicable) {
      if (sc.config.logging !== undefined) {
        mergedLogging = sc.config.logging
      }
    }

    // --- Authentication: most specific wins ---
    let mergedAuthentication: SecuritySchema.Authentication | undefined
    for (const sc of applicable) {
      if (sc.config.authentication !== undefined) {
        mergedAuthentication = sc.config.authentication
      }
    }

    // --- MCP: most restrictive wins ---
    const mcpConfigs = applicable.filter((c) => c.config.mcp)
    const mergedMcp =
      mcpConfigs.length > 0
        ? (() => {
            let defaultPolicy: SecuritySchema.McpPolicy = "trusted"
            const servers: Record<string, SecuritySchema.McpPolicy> = {}

            for (const entry of mcpConfigs) {
              if (!entry.config.mcp) continue
              defaultPolicy = mostRestrictiveMcpPolicy(defaultPolicy, entry.config.mcp.defaultPolicy)
              for (const [serverName, policy] of Object.entries(entry.config.mcp.servers)) {
                const existing = servers[serverName]
                servers[serverName] = existing ? mostRestrictiveMcpPolicy(existing, policy) : policy
              }
            }

            return { defaultPolicy, servers }
          })()
        : undefined

    const hasEmptyAllowlist = resolvedAllowlist.some((l) => l.entries.length === 0)
    if (hasEmptyAllowlist) {
      log.warn("Empty allowlist configured — all LLM operations will be denied. No files are accessible to the LLM.")
    }

    const result: SecuritySchema.ResolvedSecurityConfig = {
      version: applicable[0].config.version,
      roles: mergedRoles.length > 0 ? mergedRoles : undefined,
      rules: mergedRules && mergedRules.length > 0 ? mergedRules : undefined,
      segments: mergedSegments,
      logging: mergedLogging,
      authentication: mergedAuthentication,
      mcp: mergedMcp,
      resolvedAllowlist,
    }

    // Cache the resolved config — keyed by the resolved absolute path.
    // The cache is bounded: evict oldest when it exceeds 1024 entries.
    if (resolveCache.size >= 1024) {
      const firstKey = resolveCache.keys().next().value
      if (firstKey !== undefined) resolveCache.delete(firstKey)
    }
    resolveCache.set(resolved, result)

    return result
  }

  // --- Scope filtering ---

  /**
   * Filter rules: remove patterns that escape the config's scope via `../`
   */
  function filterScopedRules(rules: SecuritySchema.Rule[], scopeDir: string): SecuritySchema.Rule[] {
    return rules.filter((rule) => !patternEscapesScope(rule.pattern, scopeDir))
  }

  function filterScopedAllowlist(
    entries: SecuritySchema.AllowlistEntry[],
    scopeDir: string,
  ): SecuritySchema.AllowlistEntry[] {
    return entries.filter((entry) => !patternEscapesScope(entry.pattern, scopeDir))
  }

  /**
   * Check if a pattern would escape its scope directory.
   * Returns true if the pattern uses `../` to go above scopeDir.
   */
  function patternEscapesScope(pattern: string, scopeDir: string): boolean {
    if (!pattern.includes("..")) return false
    // Resolve the pattern against scopeDir and check if it escapes
    const resolved = path.resolve(scopeDir, pattern.replace(/[*?[\]{}]/g, "x"))
    return !resolved.startsWith(scopeDir + "/") && resolved !== scopeDir
  }

  // --- Backward-compatible API ---

  /**
   * Load a single config file from a given path.
   * Returns undefined if file doesn't exist or is invalid.
   */
  async function loadConfigFile(configPath: string): Promise<SecuritySchema.SecurityConfig | undefined> {
    const file = Bun.file(configPath)
    const exists = await file.exists()
    if (!exists) return undefined

    const text = await file.text().catch((err) => {
      log.warn("failed to read security config file", { path: configPath, error: err })
      return undefined
    })
    if (!text) return undefined

    const parsed = await Promise.resolve()
      .then(() => JSON.parse(text))
      .catch((err) => {
        log.warn("security config is not valid JSON", { path: configPath, error: err })
        return undefined
      })
    if (!parsed) return undefined

    const validated = SecuritySchema.securityConfigSchema.safeParse(parsed)
    if (!validated.success) {
      log.warn("malformed security config, skipping", { path: configPath, issues: validated.error.issues })
      return undefined
    }

    return validated.data
  }

  /**
   * Find the git root directory by walking up from startPath looking for .git.
   */
  function findGitRoot(startPath: string): string | undefined {
    let current = path.resolve(startPath)
    const root = path.parse(current).root

    while (current !== root) {
      const gitPath = path.join(current, ".git")
      const stat = fs.statSync(gitPath, { throwIfNoEntry: false })
      if (stat) return current
      current = path.dirname(current)
    }

    return undefined
  }

  /**
   * Find all security configs. Scans from git root downward.
   * Used by doctor and CLI commands for discovery.
   */
  export async function findSecurityConfigs(
    startPath: string,
  ): Promise<{ config: SecuritySchema.SecurityConfig; path: string }[]> {
    const resolved = path.resolve(startPath)
    const gitRoot = findGitRoot(resolved)
    const scanRoot = gitRoot ?? resolved
    const all = await scanAllConfigs(scanRoot)
    return all.map((c) => ({ config: c.config, path: c.path }))
  }

  const MCP_POLICY_PRIORITY: Record<SecuritySchema.McpPolicy, number> = {
    blocked: 3,
    enforced: 2,
    trusted: 1,
  }

  function mostRestrictiveMcpPolicy(
    a: SecuritySchema.McpPolicy,
    b: SecuritySchema.McpPolicy,
  ): SecuritySchema.McpPolicy {
    return MCP_POLICY_PRIORITY[a] >= MCP_POLICY_PRIORITY[b] ? a : b
  }

  /**
   * @deprecated Use resolveForPath() for scope-aware config resolution.
   * Returns the resolved config for the project root scope.
   */
  export function mergeSecurityConfigs(
    configs: { config: SecuritySchema.SecurityConfig; path: string }[],
  ): SecuritySchema.ResolvedSecurityConfig {
    if (configs.length === 0) return emptyConfig
    if (configs.length === 1) {
      const entry = configs[0]
      const resolvedAllowlist: SecuritySchema.AllowlistLayer[] = entry.config.allowlist
        ? [{ source: entry.path, entries: entry.config.allowlist }]
        : []
      return { ...entry.config, resolvedAllowlist }
    }

    // For backward compat: union merge (used by tests that call mergeSecurityConfigs directly)
    const roleMap = new Map<string, number>()
    for (const { config } of configs) {
      for (const role of config.roles ?? []) {
        const existing = roleMap.get(role.name)
        if (existing !== undefined && existing !== role.level) {
          throw new Error(
            `Role conflict: role '${role.name}' has level ${existing} in one config but level ${role.level} in another`,
          )
        }
        roleMap.set(role.name, role.level)
      }
    }
    const mergedRoles: SecuritySchema.Role[] = [...roleMap.entries()].map(([name, level]) => ({ name, level }))
    const mergedRules: SecuritySchema.Rule[] = configs.flatMap((c) => c.config.rules ?? [])
    const resolvedAllowlist: SecuritySchema.AllowlistLayer[] = configs
      .filter((c) => c.config.allowlist !== undefined)
      .map((c) => ({ source: c.path, entries: c.config.allowlist! }))

    return {
      version: configs[0].config.version,
      roles: mergedRoles.length > 0 ? mergedRoles : undefined,
      rules: mergedRules.length > 0 ? mergedRules : undefined,
      resolvedAllowlist,
    }
  }

  /**
   * Get the resolved security config for the project root scope.
   * For per-path resolution, use resolveForPath() instead.
   */
  export function getSecurityConfig(): SecuritySchema.ResolvedSecurityConfig {
    if (!configLoaded) {
      log.warn("getSecurityConfig called before config was loaded, returning empty config")
      return emptyConfig
    }
    return resolveForPath(projectRootDir)
  }

  /**
   * Get all loaded scoped configs. Used by doctor and advanced callers.
   */
  export function getScopedConfigs(): readonly ScopedConfig[] {
    return scopedConfigs
  }

  export function resetConfig(): void {
    scopedConfigs = []
    projectRootDir = ""
    configLoaded = false
    scanCache = null
    resolveCache.clear()
  }

  /**
   * Get the MCP security policy for a given server name.
   */
  export function getMcpPolicy(serverName: string): "enforced" | "trusted" | "blocked" {
    const config = getSecurityConfig()
    if (!config.mcp) {
      return "trusted"
    }

    const serverPolicy = config.mcp.servers?.[serverName]
    if (serverPolicy) {
      return serverPolicy
    }

    return config.mcp.defaultPolicy ?? "trusted"
  }
}
