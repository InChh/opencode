import path from "path"
import { SecurityConfig } from "./config"
import { SecuritySchema } from "./schema"
import { minimatch } from "minimatch"
import { isGlobPattern } from "../sandbox/glob-to-regex"

export interface SecurityDiagnostic {
  level: "error" | "warn" | "info"
  category: string
  message: string
  fix?: string
}

export async function runSecurityDoctor(projectRoot: string): Promise<SecurityDiagnostic[]> {
  const diagnostics: SecurityDiagnostic[] = []

  // Phase 1: Config file parsing
  await checkConfigParsing(projectRoot, diagnostics)

  // Phase 2: Load and analyze resolved config
  const config = SecurityConfig.getSecurityConfig()
  checkRoleReferences(config, diagnostics)
  checkDenyRules(config, diagnostics)
  checkAllowlistDenyOverlap(config, diagnostics)
  checkGlobPatterns(config, diagnostics)
  checkSandboxCompatibility(config, diagnostics)
  checkRedundantRules(config, diagnostics)

  return diagnostics
}

async function checkConfigParsing(projectRoot: string, diagnostics: SecurityDiagnostic[]) {
  const configFile = path.join(projectRoot, ".opencode-security.json")
  const file = Bun.file(configFile)
  const exists = await file.exists()

  if (!exists) {
    diagnostics.push({
      level: "info",
      category: "config",
      message: "No .opencode-security.json found — security rules inactive",
    })
    return
  }

  // JSON parse check
  let parsed: unknown
  try {
    const text = await file.text()
    parsed = JSON.parse(text)
  } catch (err) {
    diagnostics.push({
      level: "error",
      category: "config",
      message: `.opencode-security.json is not valid JSON: ${(err as Error).message}`,
      fix: "Fix JSON syntax errors (missing commas, trailing commas, unquoted keys, etc.)",
    })
    return
  }

  // Schema validation
  const validated = SecuritySchema.securityConfigSchema.safeParse(parsed)
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      diagnostics.push({
        level: "error",
        category: "schema",
        message: `Schema error at ${issue.path.join(".")}: ${issue.message}`,
        fix: "Fix the field value to match the expected schema",
      })
    }
    return
  }

  diagnostics.push({
    level: "info",
    category: "config",
    message: `Config loaded from ${configFile}`,
  })

  // Check for multiple config files
  const configs = await SecurityConfig.findSecurityConfigs(projectRoot)
  if (configs.length > 1) {
    diagnostics.push({
      level: "info",
      category: "config",
      message: `${configs.length} config files found (rules are merged): ${configs.map((c) => c.path).join(", ")}`,
    })
  }
}

function checkRoleReferences(config: SecuritySchema.ResolvedSecurityConfig, diagnostics: SecurityDiagnostic[]) {
  const definedRoles = new Set((config.roles ?? []).map((r) => r.name))

  for (const rule of config.rules ?? []) {
    for (const roleName of rule.allowedRoles) {
      if (!definedRoles.has(roleName)) {
        diagnostics.push({
          level: "warn",
          category: "roles",
          message: `Rule '${rule.pattern}' references undefined role '${roleName}'`,
          fix: `Add role '${roleName}' to the roles array, or remove it from allowedRoles`,
        })
      }
    }
  }

  // Check segments too
  for (const marker of config.segments?.markers ?? []) {
    for (const roleName of marker.allowedRoles) {
      if (!definedRoles.has(roleName)) {
        diagnostics.push({
          level: "warn",
          category: "roles",
          message: `Marker segment '${marker.start}' references undefined role '${roleName}'`,
          fix: `Add role '${roleName}' to the roles array`,
        })
      }
    }
  }

  for (const ast of config.segments?.ast ?? []) {
    for (const roleName of ast.allowedRoles) {
      if (!definedRoles.has(roleName)) {
        diagnostics.push({
          level: "warn",
          category: "roles",
          message: `AST segment '${ast.namePattern}' references undefined role '${roleName}'`,
          fix: `Add role '${roleName}' to the roles array`,
        })
      }
    }
  }

  // Check for empty allowedRoles (no one can bypass)
  for (const rule of config.rules ?? []) {
    if (rule.allowedRoles.length === 0) {
      diagnostics.push({
        level: "info",
        category: "roles",
        message: `Rule '${rule.pattern}' has empty allowedRoles — no role can bypass this deny`,
      })
    }
  }
}

function checkDenyRules(config: SecuritySchema.ResolvedSecurityConfig, diagnostics: SecurityDiagnostic[]) {
  const rules = config.rules ?? []
  if (rules.length === 0) return

  // Check for rules with no deniedOperations
  for (const rule of rules) {
    if (rule.deniedOperations.length === 0) {
      diagnostics.push({
        level: "warn",
        category: "rules",
        message: `Rule '${rule.pattern}' has empty deniedOperations — this rule has no effect`,
        fix: "Add operations to deny, e.g. [\"read\", \"write\"] or remove the rule",
      })
    }
  }
}

function checkAllowlistDenyOverlap(config: SecuritySchema.ResolvedSecurityConfig, diagnostics: SecurityDiagnostic[]) {
  const rules = config.rules ?? []
  const allowEntries = config.resolvedAllowlist.flatMap((l) => l.entries)

  if (rules.length === 0 || allowEntries.length === 0) return

  // Check if any deny pattern overlaps with an allowlist pattern
  for (const rule of rules) {
    for (const allow of allowEntries) {
      const overlap = patternsOverlap(rule.pattern, allow.pattern)
      if (overlap) {
        diagnostics.push({
          level: "info",
          category: "overlap",
          message: `Deny rule '${rule.pattern}' overlaps with allowlist entry '${allow.pattern}' — deny takes precedence for operations: [${rule.deniedOperations.join(", ")}]`,
        })
      }
    }
  }
}

function patternsOverlap(a: string, b: string): boolean {
  // If either is a glob, check if one could match the other
  if (isGlobPattern(a) && isGlobPattern(b)) {
    // Both globs — check common base
    const aBase = a.split("/").filter((s) => !isGlobPattern(s)).join("/")
    const bBase = b.split("/").filter((s) => !isGlobPattern(s)).join("/")
    // If concrete prefixes share a common path, they likely overlap
    if (aBase === "" || bBase === "") return true
    return aBase.startsWith(bBase) || bBase.startsWith(aBase)
  }

  // One concrete, one glob — check match
  if (isGlobPattern(a)) {
    return minimatch(b, a, { matchBase: true }) || minimatch(b + "/test", a, { matchBase: true })
  }
  if (isGlobPattern(b)) {
    return minimatch(a, b, { matchBase: true }) || minimatch(a + "/test", b, { matchBase: true })
  }

  // Both concrete
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/")
}

function checkGlobPatterns(config: SecuritySchema.ResolvedSecurityConfig, diagnostics: SecurityDiagnostic[]) {
  const allPatterns: { pattern: string; source: string }[] = []

  for (const rule of config.rules ?? []) {
    allPatterns.push({ pattern: rule.pattern, source: `deny rule '${rule.pattern}'` })
  }
  for (const layer of config.resolvedAllowlist) {
    for (const entry of layer.entries) {
      allPatterns.push({ pattern: entry.pattern, source: `allowlist entry '${entry.pattern}'` })
    }
  }

  for (const { pattern, source } of allPatterns) {
    // Check for suspicious patterns
    if (pattern === "**" || pattern === "**/**") {
      diagnostics.push({
        level: "warn",
        category: "glob",
        message: `${source} matches ALL files — this is likely too broad`,
        fix: "Use a more specific pattern",
      })
    }

    // Check for absolute paths (should be relative)
    if (pattern.startsWith("/")) {
      diagnostics.push({
        level: "warn",
        category: "glob",
        message: `${source} uses an absolute path — patterns should be relative to project root`,
        fix: "Use a relative path instead",
      })
    }

    // Validate minimatch doesn't throw
    if (isGlobPattern(pattern)) {
      try {
        minimatch("test", pattern)
      } catch {
        diagnostics.push({
          level: "error",
          category: "glob",
          message: `${source} has invalid glob syntax`,
          fix: "Fix the glob pattern syntax",
        })
      }
    }
  }
}

function checkSandboxCompatibility(config: SecuritySchema.ResolvedSecurityConfig, diagnostics: SecurityDiagnostic[]) {
  const rules = config.rules ?? []

  for (const rule of rules) {
    const ops = rule.deniedOperations
    // write-only rules can't be enforced by sandbox
    if (ops.includes("write") && !ops.includes("read") && !ops.includes("llm")) {
      diagnostics.push({
        level: "warn",
        category: "sandbox",
        message: `Rule '${rule.pattern}' denies only ['write'] — sandbox cannot enforce write-only deny (it blocks both read+write). This rule is enforced at application layer only, not OS level.`,
        fix: "If OS-level enforcement is needed, add 'read' to deniedOperations. If app-layer-only is intentional, this warning can be ignored.",
      })
    }
  }
}

function checkRedundantRules(config: SecuritySchema.ResolvedSecurityConfig, diagnostics: SecurityDiagnostic[]) {
  const rules = config.rules ?? []

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]
      const b = rules[j]

      // Same pattern, same type
      if (a.pattern === b.pattern && a.type === b.type) {
        const aOps = new Set(a.deniedOperations)
        const bOps = new Set(b.deniedOperations)
        const sameOps = a.deniedOperations.length === b.deniedOperations.length && a.deniedOperations.every((o) => bOps.has(o))

        if (sameOps) {
          diagnostics.push({
            level: "warn",
            category: "redundant",
            message: `Duplicate rules found for pattern '${a.pattern}' with same deniedOperations [${a.deniedOperations.join(", ")}]`,
            fix: "Remove one of the duplicate rules",
          })
        } else {
          diagnostics.push({
            level: "info",
            category: "redundant",
            message: `Multiple rules for pattern '${a.pattern}': [${a.deniedOperations.join(", ")}] and [${b.deniedOperations.join(", ")}] — these could be merged`,
          })
        }
      }
    }
  }
}
