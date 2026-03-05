---
name: omo-sync
description: "Compare and sync oh-my-opencode (OMO) changes into the codebase. Fetches latest OMO from npm, runs diff against baseline, generates a backport plan, and applies changes incrementally. Triggers on: omo-sync, sync omo, oh-my-opencode sync, omo update, backport omo."
user-invocable: true
---

# OMO Sync

Fetch the latest oh-my-opencode release from npm, compare against the local baseline, generate a diff report, and selectively backport new features. Phased workflow with ledger tracking.

---

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--ledger` | No | `.claude/state/omo-sync-ledger.json` | Path to the OMO sync ledger |
| `--phase` | No | — | Force a specific phase |
| `--component` | No | — | Process only this component in the `backport` phase |
| `--skip` | No | — | Mark a component as `skipped` |
| `--version` | No | `latest` | Specific OMO npm version to compare against |

---

## Workflow Overview

```
Phase 1: FETCH     → Download latest OMO from npm, extract to temp dir
Phase 2: DIFF      → Run omo-diff.ts, generate structured diff report
Phase 3: PLAN      → Categorize changes, create backport plan with priorities
Phase 4: BACKPORT  → Apply one component at a time, adapting to current codebase
Phase 5: VERIFY    → Typecheck + test suite
Phase 6: BASELINE  → Update .omo-baseline.json to reflect new version
```

Each phase writes to the ledger. Re-invoke to continue.

---

## Phase 1: FETCH

### Purpose
Download the latest (or specified) oh-my-opencode package from npm and extract it.

### Steps

1. **Check current baseline:**
   ```bash
   cat packages/opencode/.omo-baseline.json | head -5
   ```
   Record the current baseline version.

2. **Fetch OMO package info:**
   ```bash
   npm view oh-my-opencode@<version> version dist.tarball
   ```

3. **Download and extract:**
   ```bash
   TMPDIR=$(mktemp -d)
   curl -sL <tarball_url> | tar xz -C $TMPDIR
   ```
   Record `$TMPDIR/package` as the extracted path.

4. **Initialize ledger:**
   ```json
   {
     "session_id": "omo-sync-YYYYMMDD-HHMMSS",
     "created_at": "<iso>",
     "updated_at": "<iso>",
     "baseline_version": "<current>",
     "target_version": "<new>",
     "extracted_path": "<tmpdir>/package",
     "components": [],
     "phases": {
       "fetch": { "status": "done" },
       "diff": { "status": "pending" },
       "plan": { "status": "pending" },
       "backport": { "status": "pending" },
       "verify": { "status": "pending" },
       "baseline": { "status": "pending" }
     }
   }
   ```

5. **Print:**
   ```
   FETCH COMPLETE:
     Baseline version: <current>
     Target version: <new>
     Extracted to: <path>
   ```

---

## Phase 2: DIFF

### Purpose
Run the existing `omo-diff.ts` script to generate a structured comparison.

### Steps

1. **Run omo-diff:**
   ```bash
   bun run script/omo-diff.ts 2>&1
   ```
   If the script fails, fall back to manual scanning (Phase 2B).

2. **If omo-diff succeeds**, read the generated report from `tasks/omo-diff-report-<version>.md`.

3. **If omo-diff fails (Phase 2B — manual scan):**
   Scan the extracted OMO package directory to inventory components:

   - **Tools:** List directories in `<extracted>/src/tools/`
   - **Hooks:** List directories in `<extracted>/src/hooks/`
   - **Agents:** List files/directories in `<extracted>/src/agents/`
   - **Config:** List files in `<extracted>/src/config/`
   - **Features:** List files in `<extracted>/src/features/`

   For each component, check if it exists in the baseline:
   - **New** (not in baseline) → category: `backport_recommended`
   - **Changed** (in baseline, but file content differs) → category: `review_needed`
   - **Unchanged** → category: `up_to_date`
   - **Baseline says `skipped`** → category: `skip_diverged`

4. **Update ledger** with the full component inventory.

5. **Print summary:**
   ```
   DIFF COMPLETE:
     New components: N (backport recommended)
     Changed components: M (review needed)
     Up-to-date: K
     Skipped (diverged): J
   ```

---

## Phase 3: PLAN

### Purpose
Create a prioritized backport plan. Determine which components to bring in, their order, and adaptation strategy.

### Steps

1. **For each `backport_recommended` component**, assess:
   - **Impact:** What OpenCode files would it affect?
   - **Dependencies:** Does it require other components?
   - **Complexity:** How much adaptation is needed for the current codebase?

2. **For each `review_needed` component**, assess:
   - **Delta size:** How much changed?
   - **Our divergence:** Did we intentionally modify this component?
   - **Risk:** Could updating break our custom behavior?

3. **Assign priority:**

   | Priority | Criteria |
   |----------|----------|
   | P0 | Bug fixes in components we already internalized |
   | P1 | New hooks/tools that improve existing functionality |
   | P2 | New agents or optional features |
   | P3 | Config/dependency updates |
   | P4 | Cosmetic or minor improvements |

4. **Create the backport plan** — ordered list of components with:
   - Component name and type (tool/hook/agent/config)
   - Category (backport/review/skip)
   - Priority
   - Target files in OpenCode
   - Adaptation notes (what needs to change for our architecture)
   - Dependencies (must be applied before/after)

5. **Update ledger** with the plan.

6. **Print the plan** and ask for user review:
   ```
   BACKPORT PLAN:
     P0:
       - [hook] error-recovery: Bug fix in retry logic (affects: src/session/hooks/error-recovery.ts)
     P1:
       - [tool] new-tool-name: New capability (create: src/tool/new-tool-name.ts)
     P2:
       - [agent] new-agent: Optional agent (create: src/agent/prompt/new-agent.txt)

   Review the plan. To proceed: /omo-sync
   To skip a component: /omo-sync --skip <component-name>
   ```

---

## Phase 4: BACKPORT

### Purpose
Apply changes one component at a time. Each invocation processes ONE component.

### Execution Model

Select the highest-priority non-terminal component. If `--component` is specified, process that one.

### Steps for Each Component

1. **Read the OMO source** for this component from the extracted package.

2. **Read the corresponding OpenCode file** (if it exists).

3. **Determine adaptation strategy:**

   **A. New component (no OpenCode equivalent):**
   - Create the file at the appropriate location
   - Adapt imports to match OpenCode's module structure
   - Adapt types to match OpenCode's type system
   - Register the component (add to agent list, hook chain, tool registry, etc.)

   **B. Updated component (OpenCode file exists):**
   - Diff the OMO version against our current version
   - Identify specific changes (new functions, modified logic, bug fixes)
   - Apply changes surgically — preserve our customizations, merge in OMO improvements
   - Do NOT blindly overwrite — our version may have intentional divergence

   **C. Skipped component:**
   - Mark as `skipped` and move on

4. **Follow code conventions** from CLAUDE.md:
   - No try/catch, no any, no else, prefer const, etc.
   - Ensure the adapted code matches OpenCode's style

5. **Update ledger** with component status and modified files.

6. **Print:**
   ```
   BACKPORT [hook] error-recovery:
     Strategy: updated (merged bug fix)
     Files modified: src/session/hooks/error-recovery.ts
     Status: applied

   Next: /omo-sync (continues to next component)
   ```

---

## Phase 5: VERIFY

### Purpose
Same as upstream-sync Phase 5 — typecheck and test.

### Steps

1. **Typecheck:**
   ```bash
   bun turbo typecheck 2>&1
   ```

2. **Test suite:**
   Invoke `/test-analyze --scope bun`.

3. **Update ledger** with results.

4. **Print results** with actionable guidance on failures.

---

## Phase 6: BASELINE

### Purpose
Update `.omo-baseline.json` to reflect the new version and any newly internalized components.

### Steps

1. **Read current baseline** from `packages/opencode/.omo-baseline.json`.

2. **Update version** to the target version from Phase 1.

3. **Update date** to current ISO date.

4. **Add new components** that were successfully backported:
   - Add entries with `status: "internalized"` for each applied component

5. **Update existing components** that were refreshed.

6. **Write baseline** back to disk.

7. **Clean up:**
   - Remove the extracted temp directory
   - Optionally generate a summary commit

8. **Print:**
   ```
   BASELINE UPDATED:
     Version: <old> → <new>
     New components internalized: N
     Updated components: M
     Skipped: K
   ```

---

## Recovery

- **Context blowup:** Re-invoke `/omo-sync`. Reads ledger and resumes.
- **Bad backport:** Revert files with `git checkout -- <file>`, update ledger component status to `pending`.
- **Start over:** Delete the ledger file and re-invoke.
- **Temp dir deleted:** Re-run `/omo-sync --phase fetch` to re-download.

---

## Checklist

Before exiting each phase:

- [ ] Ledger written to disk with updated status
- [ ] No uncommitted changes left hanging (either committed or reverted)
- [ ] Print summary with next steps
- [ ] Code changes follow CLAUDE.md conventions
