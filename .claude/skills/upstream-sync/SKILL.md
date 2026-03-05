---
name: upstream-sync
description: "Sync local master branch with upstream/dev: fetch, analyze, integrate upstream changes, and re-apply custom features. Phased workflow with ledger tracking to survive context limits. Triggers on: upstream-sync, sync upstream, update from upstream, rebase on upstream."
user-invocable: true
---

# Upstream Sync

Incrementally sync local `master` with `upstream/dev`. This is a **phased, ledger-driven workflow** — each invocation executes ONE phase, writes progress to the ledger, and exits. Re-invoke to continue from where it left off.

---

## Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--ledger` | No | `.claude/state/upstream-sync-ledger.json` | Path to the sync ledger file |
| `--phase` | No | — | Force execution of a specific phase (skip auto-detection) |
| `--group` | No | — | Cherry-pick only this feature group ID (for `cherry-pick` phase) |
| `--skip-group` | No | — | Mark this feature group as `skipped` and move to next |
| `--drop-group` | No | — | Mark this feature group as `dropped` (permanently excluded) |

---

## Workflow Overview

```
Phase 1: INIT      → Create ledger, backup branch, fetch upstream
Phase 2: ANALYZE   → Categorize custom commits into feature groups, identify conflicts
Phase 3: INTEGRATE → Create integration branch from upstream/dev HEAD
Phase 4: CHERRY    → Cherry-pick feature groups one-by-one onto integration branch
Phase 5: VERIFY    → Typecheck + test suite
Phase 6: FINALIZE  → Fast-forward master to integration branch
```

Each phase is **idempotent** — re-running a completed phase is a no-op. If a phase fails or the context explodes, re-invoke `/upstream-sync` and it resumes from the last incomplete phase.

---

## Phase Detection

On each invocation:

1. Read the ledger from `--ledger` path.
2. If ledger does not exist → start Phase 1.
3. If ledger exists → scan `phases` object for the first phase with `status != "done"` and `status != "skipped"`.
4. If `--phase` is provided → jump directly to that phase (useful for retries).
5. Execute exactly ONE phase, update the ledger, write to disk, and exit.

---

## Phase 1: INIT

### Purpose
Create the sync ledger with all metadata, backup the current branch, and fetch upstream.

### Steps

1. **Fetch upstream:**
   ```bash
   git fetch upstream
   ```

2. **Compute metadata:**
   ```bash
   MERGE_BASE=$(git merge-base master upstream/dev)
   UPSTREAM_HEAD=$(git rev-parse upstream/dev)
   LOCAL_HEAD=$(git rev-parse master)
   CUSTOM_COUNT=$(git rev-list --count $MERGE_BASE..master)
   UPSTREAM_COUNT=$(git rev-list --count $MERGE_BASE..upstream/dev)
   ```

3. **Create backup branch:**
   ```bash
   git branch master-backup-YYYYMMDD master
   ```

4. **Initialize ledger:**
   - `session_id`: Generate a unique ID (e.g., `sync-YYYYMMDD-HHMMSS`)
   - Fill all metadata fields from computed values
   - `integration_branch`: `feat/upstream-sync-YYYYMMDD`
   - `feature_groups`: empty array (populated in Phase 2)
   - All phases set to `status: "pending"` except `backup` and `fetch` → `"done"`
   - `notes`: record the commit counts and merge-base

5. **Create directory and write ledger:**
   ```bash
   mkdir -p .claude/state
   ```
   Write the ledger JSON (2-space indent) to the `--ledger` path.

6. **Print summary:**
   ```
   INIT COMPLETE:
     Merge base: <sha-short>
     Custom commits: N
     Upstream new commits: M
     Backup: master-backup-YYYYMMDD
     Ledger: <path>
   ```

---

## Phase 2: ANALYZE

### Purpose
Categorize all custom commits (on master but not on upstream) into feature groups for selective cherry-picking.

### Steps

1. **List custom commits:**
   ```bash
   git log --oneline --reverse $MERGE_BASE..master
   ```

2. **Auto-categorize commits** by scanning commit messages for known patterns. Create feature groups:

   | Group ID | Name | Pattern |
   |----------|------|---------|
   | `omo` | OMO Internalization | Messages containing `omo`, `hook`, `sisyphus`, `oracle`, `agent enforcement`, `context injection`, `output management`, `detection`, `llm parameter`, `session lifecycle`, `background` |
   | `security` | Security System | Messages containing `security`, `access`, `audit`, `scanner`, `segment`, `role`, `token`, `allowlist` |
   | `sandbox` | OS Native Sandbox | Messages containing `sandbox`, `seatbelt` |
   | `test-infra` | Test Infrastructure | Messages containing `test-fix`, `test-analyze`, `parallel test`, `test runner` |
   | `ci` | CI/Infra | Messages containing `ci:`, `feishu`, `webhook`, `omo-diff` |
   | `keybinding` | Keybinding Customization | Messages containing `keybind`, `Ctrl+J`, `Shift+Enter`, `newline` |
   | `misc` | Miscellaneous | Everything else |

3. **For each commit**, assign it to the matching group. If a commit matches multiple groups, assign to the first match in the table order.

4. **Identify conflict risk** for each group by checking if the group's commits touch files that upstream also modified:
   ```bash
   # For each commit in the group
   git diff-tree --no-commit-id --name-only -r <sha>
   # Cross-reference against upstream changes
   git diff --name-only $MERGE_BASE upstream/dev
   ```
   Record overlapping files as `conflict_risk_areas`.

5. **Update ledger:**
   - Set `feature_groups` with all groups, each commit's `status: "pending"`
   - Set `phases.analyze.status` to `"done"`
   - Record file counts and conflict risk areas in `phases.analyze`

6. **Print summary per group:**
   ```
   ANALYZE COMPLETE:
     Group: omo (24 commits, 15 files at risk)
     Group: security (42 commits, 8 files at risk)
     Group: sandbox (5 commits, 6 files at risk)
     ...
   ```

---

## Phase 3: INTEGRATE

### Purpose
Create the integration branch starting from upstream/dev HEAD.

### Steps

1. **Ensure working tree is clean:**
   ```bash
   git status --porcelain
   ```
   If dirty, abort with `ERROR: Working tree is dirty. Commit or stash changes first.`

2. **Create integration branch:**
   ```bash
   git checkout -b <integration_branch> upstream/dev
   ```

3. **Update ledger:**
   - Set `phases.integrate.status` to `"done"`
   - Set `phases.integrate.strategy` to `"reset_and_cherry_pick"`

4. **Print:**
   ```
   INTEGRATE COMPLETE:
     Branch: <integration_branch>
     Based on: upstream/dev (<sha-short>)
   ```

---

## Phase 4: CHERRY-PICK

### Purpose
Apply each feature group's commits onto the integration branch. This is the **most complex phase** and may require multiple invocations.

### Execution Model

Each invocation processes **ONE feature group**. If `--group` is specified, process that group. Otherwise, process the first group with `status: "pending"`.

### Steps

1. **Select group:**
   - If `--group` is provided, find that group by ID
   - If `--skip-group` is provided, set that group's status to `"skipped"` and exit
   - If `--drop-group` is provided, set that group's status to `"dropped"` and exit
   - Otherwise, select the first group with `status: "pending"`
   - If no pending groups remain, mark `phases.cherry_pick.status` as `"done"` and exit

2. **Ensure on integration branch:**
   ```bash
   git checkout <integration_branch>
   ```

3. **Cherry-pick each commit in the group sequentially:**
   ```bash
   git cherry-pick <sha>
   ```

   **On success:** Set the commit's `status` to `"applied"`.

   **On conflict:**
   - Run `git diff --name-only --diff-filter=U` to list conflicting files
   - Record `conflict_files` on the commit
   - **Attempt auto-resolution:**
     - If the conflict is in a file that was **deleted** by upstream (our custom file no longer has a home), note it as needing manual adaptation
     - If the conflict is a simple content merge, read both sides and attempt resolution
   - If resolution succeeds: `git add <files> && git cherry-pick --continue`
   - If resolution fails or is too complex:
     - `git cherry-pick --abort`
     - Set the commit's `status` to `"conflict"`
     - Set the group's `status` to `"conflict"`
     - Record `conflict_summary` with details
     - **Stop processing this group** — do not attempt remaining commits
     - Print the conflict details and ask for manual intervention

4. **After all commits in the group:**
   - If all applied successfully: set group `status` to `"applied"`
   - If any had conflicts: group `status` is already `"conflict"`

5. **Update ledger** with group status and counters.

6. **Print:**
   ```
   CHERRY-PICK GROUP <id>:
     Name: <name>
     Commits: N total, M applied, K conflicts, J skipped
     Status: applied | conflict | skipped
   ```

### Conflict Resolution Guidance

When a conflict occurs, print actionable guidance:

```
CONFLICT in group <id> (<name>):
  Commit: <sha-short> <message>
  Conflicting files:
    - <file1>
    - <file2>

  Suggested actions:
  1. Resolve manually, then re-run: /upstream-sync --phase cherry-pick --group <id>
  2. Skip this group: /upstream-sync --skip-group <id>
  3. Drop this group permanently: /upstream-sync --drop-group <id>
```

---

## Phase 5: VERIFY

### Purpose
Run typecheck and test suite on the integration branch to verify everything works.

### Steps

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Typecheck:**
   ```bash
   bun turbo typecheck 2>&1
   ```
   Record pass/fail in `phases.verify.typecheck_pass`.

3. **Run tests** (if typecheck passes):
   Invoke `/test-analyze --scope bun` and save the report.
   Record pass/fail in `phases.verify.test_pass`.

4. **Update ledger:**
   - If both pass: `phases.verify.status` = `"pass"`
   - If either fails: `phases.verify.status` = `"fail"`, record the report path

5. **Print:**
   ```
   VERIFY:
     Typecheck: PASS | FAIL
     Tests: PASS | FAIL (N pass, M fail)
     Status: PASS | FAIL
   ```

   If FAIL, suggest:
   ```
   Fix the issues, then re-run: /upstream-sync --phase verify
   ```

---

## Phase 6: FINALIZE

### Purpose
Merge the integration branch into master (fast-forward or merge commit).

### Prerequisites
`phases.verify.status` must be `"pass"`. If not, abort with guidance to fix issues first.

### Steps

1. **Confirm with user** before proceeding — this replaces master.

2. **Merge into master:**
   ```bash
   git checkout master
   git merge <integration_branch> --no-ff -m "chore: sync with upstream/dev ($(date +%Y-%m-%d))"
   ```

3. **Print final summary:**
   ```
   FINALIZE COMPLETE:
     master updated to include upstream/dev changes
     Backup available at: <backup_branch>
     Integration branch: <integration_branch>

     Feature groups:
       ✓ omo (applied)
       ✓ security (applied)
       ✗ sandbox (skipped — needs adaptation)
       ...

     Next steps:
       - Push to origin: git push origin master
       - Run /omo-sync to check oh-my-opencode updates
       - Clean up: git branch -d <integration_branch>
   ```

---

## Ledger Location

Default: `.claude/state/upstream-sync-ledger.json`

The ledger conforms to `.claude/schemas/upstream-sync-ledger.schema.json`.

---

## Recovery

If anything goes wrong at any phase:

- **Context blowup:** Re-invoke `/upstream-sync`. It reads the ledger and resumes.
- **Bad cherry-pick:** `git cherry-pick --abort` on the integration branch, then re-run.
- **Want to start over:** Delete the ledger file and the integration branch, then re-invoke.
- **Backup restore:** `git checkout master && git reset --hard <backup_branch>`.

---

## Checklist

Before exiting each phase, verify:

- [ ] Ledger is written to disk with updated phase status
- [ ] Git working tree is clean (no uncommitted changes)
- [ ] Current branch is correct for the phase
- [ ] Print summary includes actionable next steps
