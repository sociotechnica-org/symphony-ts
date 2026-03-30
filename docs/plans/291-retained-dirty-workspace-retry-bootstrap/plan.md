# Issue 291 Plan: Retained Dirty Workspace Retry Bootstrap

## Summary

Fix retry/bootstrap for retained local workspaces so a reclaimed issue does not
fail immediately when prior failed-attempt changes would block `git checkout -B
<default-branch> origin/<default-branch>`.

This issue is being implemented under an explicit plan-review waiver based on
direct human instruction to begin the fix immediately.

## Scope

In scope:

- local workspace reuse for retained workspaces in `src/workspace/local.ts`
- deterministic handling of dirty retained workspaces before branch reset
- preservation of retained evidence in a recoverable form
- unit coverage for the concrete retry-bootstrap failure mode

Out of scope:

- remote SSH workspace behavior
- changing the retained-workspace policy itself
- broader retry/orchestrator redesign

## Symphony Layer Mapping

- Policy:
  - preserve retained workspace evidence while still allowing retry bootstrap
- Configuration:
  - no workflow schema changes
- Coordination:
  - none beyond keeping retry bootstrap deterministic
- Execution:
  - local workspace preparation and branch reset behavior
- Integration:
  - git working tree / stash interaction for reused workspaces
- Observability:
  - logger warning when dirty retained workspaces are sanitized before reuse

## Current Gap

`context-library#111` proved that a retained workspace can contain local file
changes from a failed run, and the next reclaim path currently attempts branch
checkout/reset without first sanitizing the working tree. That causes retry
bootstrap to fail before any new coding work starts.

## Architecture Boundary

Keep the fix inside the local workspace preparation seam:

- `src/workspace/local.ts` owns the git hygiene required to make an existing
  local workspace reusable.
- The orchestrator should continue to ask for a prepared workspace without
  knowing how dirty retained state is repaired.
- Evidence preservation should remain local to workspace preparation rather than
  requiring orchestration-side special cases.

What does not belong here:

- tracker issue mutation
- retry budget / stall policy changes
- operator-specific recovery logic

## Implementation Steps

1. Add a focused helper in `src/workspace/local.ts` that detects a dirty reused
   workspace before fetch/checkout, preserves that dirty state with a
   deterministic stash entry, and leaves the working tree clean enough for the
   existing checkout/reset flow.
2. Keep the existing branch-selection logic intact after the new sanitization
   step.
3. Emit a warning log when a dirty retained workspace is sanitized so the event
   is inspectable later.
4. Add a regression test in `tests/unit/workspace-local.test.ts` that:
   - prepares a workspace
   - leaves tracked modifications in it
   - reruns `prepareWorkspace`
   - verifies preparation succeeds
   - verifies the modified file resets to upstream state
   - verifies a stash entry was created to preserve the dirty retained state

## Tests

- `pnpm exec vitest run tests/unit/workspace-local.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Acceptance Scenarios

1. Given an existing retained workspace with tracked modifications, when
   `prepareWorkspace()` runs again, then the workspace is sanitized and the
   branch reset succeeds instead of failing checkout.
2. Given that same dirty retained workspace, when preparation sanitizes it,
   then the prior dirty state remains preserved in a deterministic stash entry.

## Exit Criteria

- reused dirty workspaces no longer fail retry bootstrap on branch checkout
- retained evidence is preserved rather than silently discarded
- regression coverage reproduces and prevents the `context-library#111` failure

## Slice Strategy And PR Seam

This issue fits in one reviewable PR by staying on one narrow workspace
preparation seam: all runtime changes stay inside `src/workspace/local.ts` and
the corresponding regression coverage stays in
`tests/unit/workspace-local.test.ts`.

What does not belong in this PR:

- orchestrator retry-budget or stall-policy changes
- tracker/operator queue recovery behavior
- workflow schema or prompt changes
- remote SSH retained-workspace recovery

## Deferred

- richer archival/export of retained dirty workspace evidence
- automatic handling for conflicting untracked files in retained workspaces
- equivalent remote SSH retry-bootstrap handling if it proves necessary later
