import { Memory } from "../memory"
import { ProjectContext } from "./project-context"

export namespace TeamScopeMatcher {
  /**
   * Determines if a Team Memory matches the current project context.
   *
   * Rules:
   *   - global: true → unconditional match
   *   - Non-empty dimensions use AND logic (all must match)
   *   - Within a dimension, multiple values use OR logic (one must match)
   *   - Empty array = no filtering for that dimension
   */
  export function matches(scope: Memory.TeamScope, context: ProjectContext.Info): boolean {
    // Global memory matches unconditionally
    if (scope.global) return true

    // Check each non-empty dimension
    if (scope.projectIds.length > 0) {
      if (!scope.projectIds.includes(context.projectId)) return false
    }

    if (scope.languages.length > 0) {
      if (!scope.languages.some((l) => context.languages.includes(l))) return false
    }

    if (scope.techStack.length > 0) {
      if (!scope.techStack.some((t) => context.techStack.includes(t))) return false
    }

    if (scope.modules.length > 0) {
      if (!context.currentModulePath) return false
      if (!scope.modules.some((m) => context.currentModulePath!.startsWith(m))) return false
    }

    // All non-empty dimensions matched (fully empty = no constraints = match)
    return true
  }
}
