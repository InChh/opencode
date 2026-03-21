import { describe, test, expect } from "bun:test"
import { TeamScopeMatcher } from "../../src/memory/engine/team-scope-matcher"
import { Memory } from "../../src/memory/memory"
import type { ProjectContext } from "../../src/memory/engine/project-context"

function makeContext(overrides?: Partial<ProjectContext.Info>): ProjectContext.Info {
  return {
    projectId: "opencode",
    languages: ["typescript"],
    techStack: ["hono", "drizzle"],
    currentModulePath: "packages/opencode",
    ...overrides,
  }
}

function makeScope(overrides?: Partial<Memory.TeamScope>): Memory.TeamScope {
  return Memory.TeamScope.parse(overrides ?? {})
}

describe("TeamScopeMatcher", () => {
  describe("global scope", () => {
    test("global: true matches any context", () => {
      const scope = makeScope({ global: true })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(true)
      expect(TeamScopeMatcher.matches(scope, makeContext({ projectId: "other", languages: ["python"] }))).toBe(true)
    })
  })

  describe("projectIds dimension", () => {
    test("matches when projectId is in list", () => {
      const scope = makeScope({ projectIds: ["opencode", "other-project"] })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(true)
    })

    test("rejects when projectId is not in list", () => {
      const scope = makeScope({ projectIds: ["other-project"] })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(false)
    })
  })

  describe("languages dimension", () => {
    test("matches when at least one language overlaps (OR within dimension)", () => {
      const scope = makeScope({ languages: ["python", "typescript"] })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(true)
    })

    test("rejects when no language overlaps", () => {
      const scope = makeScope({ languages: ["python", "go"] })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(false)
    })
  })

  describe("techStack dimension", () => {
    test("matches when at least one tech overlaps", () => {
      const scope = makeScope({ techStack: ["express", "hono"] })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(true)
    })

    test("rejects when no tech overlaps", () => {
      const scope = makeScope({ techStack: ["express", "prisma"] })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(false)
    })
  })

  describe("modules dimension", () => {
    test("matches when module path is a prefix of current path", () => {
      const scope = makeScope({ modules: ["packages/opencode"] })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(true)
    })

    test("matches with nested paths", () => {
      const scope = makeScope({ modules: ["packages/"] })
      expect(TeamScopeMatcher.matches(scope, makeContext({ currentModulePath: "packages/opencode/src" }))).toBe(true)
    })

    test("rejects when no module path prefix matches", () => {
      const scope = makeScope({ modules: ["apps/web"] })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(false)
    })

    test("rejects when currentModulePath is undefined", () => {
      const scope = makeScope({ modules: ["packages/"] })
      expect(TeamScopeMatcher.matches(scope, makeContext({ currentModulePath: undefined }))).toBe(false)
    })
  })

  describe("multi-dimension AND logic", () => {
    test("matches when all non-empty dimensions match", () => {
      const scope = makeScope({
        languages: ["typescript"],
        techStack: ["hono"],
        projectIds: ["opencode"],
      })
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(true)
    })

    test("rejects when any dimension fails", () => {
      const scope = makeScope({
        languages: ["typescript"],
        techStack: ["express"],
      })
      // language matches but techStack doesn't → AND fails
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(false)
    })
  })

  describe("empty scope", () => {
    test("empty scope matches everything (no constraints)", () => {
      const scope = makeScope({})
      expect(TeamScopeMatcher.matches(scope, makeContext())).toBe(true)
      expect(TeamScopeMatcher.matches(scope, makeContext({ projectId: "any", languages: ["go"] }))).toBe(true)
    })
  })
})
