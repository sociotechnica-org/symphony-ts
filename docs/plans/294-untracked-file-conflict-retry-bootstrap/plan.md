# Issue 294 Plan: Untracked File Conflict Recovery in Retained Workspace Retry Bootstrap

## Goal

Extend retained-workspace retry bootstrap so conflicting untracked files are
removed before branch reset, preventing checkout failures while preserving
retained evidence in an inspectable form.

## Scope

In scope:

- detect and handle untracked files in retained workspaces before branch reset
- preserve untracked file evidence in git stash alongside tracked modifications
- allow retry bootstrap to proceed instead of failing on untracked path conflicts
- regression test for retained workspaces with conflicting untracked files

Out of scope:

- remote SSH workspace behavior
- changing the retained-workspace policy itself
- broader retry/orchestrator redesign
- richer archival/export of retained workspace evidence

## Non-Goals

- introducing new configuration knobs for untracked file handling
- changing workspace retention policy
- modifying orchestrator retry logic

## Symphony Layer Mapping

- **Policy:** preserve retained workspace evidence while allowing retry bootstrap
  (unchanged from #291)
- **Configuration:** no workflow schema changes
- **Coordination:** none beyond keeping retry bootstrap deterministic
- **Execution:** local workspace preparation and branch reset behavior in
  `src/workspace/local.ts`
- **Integration:** git working tree / stash interaction for reused workspaces
- **Observability:** logger warning when untracked files are cleaned before reuse

What does not belong here:

- tracker issue mutation
- retry budget / stall policy changes
- operator-specific recovery logic
- orchestrator state changes

## Current Gap

PR #292 fixed retry bootstrap for retained workspaces with **tracked**
modifications by stashing them before branch reset. However,
`stashDirtyWorkspaceForReuse` explicitly passes `--untracked-files=no` and uses
plain `git stash push` without `--include-untracked`.

If a failed coding-agent run creates new files (e.g., new source files,
generated artifacts, context library outputs), and a later retry needs to check
out a branch where those same paths are tracked, `git checkout -B` fails with:

```
error: The following untracked working tree files would be overwritten by checkout:
  <path>
```

This is the exact failure mode described in issue #294.

## Architecture Boundary

Keep the fix inside the local workspace preparation seam:

- `src/workspace/local.ts` owns git hygiene for making an existing local
  workspace reusable
- the orchestrator should not know how dirty retained state is repaired
- evidence preservation stays local to workspace preparation

What does not belong in this layer:

- tracker issue mutation
- retry budget / stall policy changes
- operator queue recovery behavior
- workflow schema or prompt changes

## Implementation Steps

1. **Modify `stashDirtyWorkspaceForReuse`** to include untracked files:
   - Change `readWorktreeStatus` call to use `includeUntracked: true` for the
     dirty-check (so the function detects untracked files as dirty state)
   - Add `--include-untracked` to the `git stash push` command so untracked
     files are captured in the stash entry alongside tracked modifications
   - This is the minimal change: the existing stash-based evidence preservation
     strategy already works; we just need to widen what it captures

2. **No new helper needed.** The existing `stashDirtyWorkspaceForReuse` already
   has the right shape. The fix is two small edits:
   - `includeUntracked: false` -> `includeUntracked: true`
   - `["stash", "push", "--message", entryName]` ->
     `["stash", "push", "--include-untracked", "--message", entryName]`

3. **Update the logger warning** metadata to distinguish tracked vs untracked
   changed paths for inspectability. The `changedPaths` field already captures
   status lines; with `includeUntracked: true`, untracked files will appear
   with `??` status markers, which is sufficient for distinguishing them in logs.

## Tests

Add a regression test in `tests/unit/workspace-local.test.ts`:

1. Prepare a workspace
2. Create an untracked file in it (e.g., `GENERATED.txt`)
3. Rerun `prepareWorkspace`
4. Verify preparation succeeds (no checkout failure)
5. Verify the untracked file is gone from the working tree
6. Verify a stash entry was created preserving the untracked file

Named acceptance scenarios:

- **Scenario: untracked-file-conflict-recovery** — Given an existing retained
  workspace with untracked files that would conflict with checkout, when
  `prepareWorkspace()` runs again, then the workspace is sanitized and the
  branch reset succeeds.
- **Scenario: untracked-file-evidence-preservation** — Given that same dirty
  retained workspace, when preparation sanitizes it, then the untracked files
  are preserved in the stash entry.
- **Scenario: mixed-tracked-and-untracked** — Given a retained workspace with
  both tracked modifications and untracked files, when `prepareWorkspace()`
  runs again, then both are stashed together and bootstrap succeeds.

## Exit Criteria

- reused retained workspaces with conflicting untracked files no longer fail
  retry bootstrap on branch checkout
- untracked file evidence is preserved in the stash entry, not silently
  discarded
- regression coverage reproduces and prevents the failure mode

## Slice Strategy and PR Seam

This issue fits in one reviewable PR. All runtime changes stay inside
`src/workspace/local.ts` (two line edits to `stashDirtyWorkspaceForReuse`) and
all test changes stay in `tests/unit/workspace-local.test.ts`.

What does not belong in this PR:

- orchestrator retry-budget or stall-policy changes
- tracker/operator queue recovery behavior
- workflow schema or prompt changes
- remote SSH retained-workspace recovery

## Deferred

- richer archival/export of retained dirty workspace evidence
- equivalent remote SSH retry-bootstrap handling
- automatic cleanup of old stash entries in long-lived workspaces
