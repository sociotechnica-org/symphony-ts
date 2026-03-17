# Issue 165 Plan: Workspace Retention And Terminal Cleanup Policy

## Status

- plan-ready

## Goal

Define and implement a clear local-workspace retention policy so successful, failed, retried, and restart-recovered runs leave predictable filesystem state without turning `.tmp/workspaces/` into a second issue-lifecycle database.

This slice should make terminal cleanup a first-class coordination-plus-execution seam: the orchestrator decides when cleanup or intentional retention is required, the workspace layer performs the filesystem mutation, and observability surfaces the resulting posture to operators.

## Scope

- define explicit retention rules for:
  - successful terminal completion
  - terminal failure
  - retry-scheduled reruns
  - restart/recovery paths that suppress rerun because the issue is already terminal
- replace the current success-only cleanup toggle with an explicit workspace retention policy contract while preserving compatibility for existing workflows where practical
- encode terminal cleanup decisions in a focused coordination helper/module instead of scattered `if cleanupOnSuccess` branches
- keep the workspace tree bounded to one deterministic workspace path per issue and rely on reset/reuse rather than per-attempt directories
- surface cleanup posture through status/actions/logs so operators can distinguish:
  - intentionally retained
  - cleanup requested
  - cleanup succeeded
  - cleanup skipped by policy
  - cleanup failed after a terminal outcome
- add unit, integration, and end-to-end coverage for the policy and its operator-visible outcomes

## Non-Goals

- designing a generic TTL janitor, archival system, or historical workspace rotation mechanism
- changing `.var/factory/...` or `.var/reports/...` artifact retention rules; those remain the canonical local evidence outside cleanup-managed workspaces
- redesigning tracker transport, tracker normalization, or tracker lifecycle semantics
- mixing detached factory process-tree cleanup or `screen` session cleanup into this issue
- introducing durable per-issue cleanup databases beyond the existing status/artifact surfaces
- changing retry/backoff policy, watchdog policy, or restart-recovery policy beyond the cleanup/retention consequences they already produce

## Current Gaps

- `src/domain/workflow.ts` and `src/config/workflow.ts` expose only `workspace.cleanupOnSuccess`, so the runtime has no explicit answer for terminal failure retention or restart-recovered terminal cleanup
- `src/orchestrator/service.ts` performs best-effort cleanup in two narrow success paths and logs `"Workspace cleanup failed"` without any operator-visible cleanup posture in status or artifacts
- `src/workspace/local.ts` only exposes destructive `cleanupWorkspace*()` operations; the execution seam does not return normalized cleanup results that coordination can project
- retry and recovery paths rely on implicit workspace reuse/reset through `prepareWorkspace()`, but that policy is not documented as a bounded retention rule
- failed issues intentionally keep their workspaces today, but that policy is implicit and not surfaced as a deliberate retention decision
- the current runtime can leave successful or merged-terminal issues in a terminally completed tracker state even when local workspace cleanup failed, yet operators only see that through logs

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

- the repo-owned rule that workspaces are disposable execution state, not durable lifecycle state
- the default retention policy for success, failure, retry, and restart-recovered terminal outcomes
- the requirement that cleanup failures never erase the already-decided terminal issue outcome

Does not belong here:

- filesystem API calls
- status rendering strings
- tracker-provider branching

### Configuration Layer

Belongs here:

- a typed workspace retention/cleanup policy contract resolved from `WORKFLOW.md`
- compatibility handling for the current `workspace.cleanup_on_success` boolean if retained as an alias or migration input

Does not belong here:

- cleanup results
- retained-workspace runtime state
- tracker-aware policy exceptions

### Coordination Layer

Belongs here:

- deciding whether a workspace should be retained, reset on next attempt, or cleaned after a terminal decision
- explicit cleanup outcome classification for success, retained failure, retained retry, skipped-by-policy, and failed cleanup
- sequencing cleanup relative to terminal completion/failure and merged-terminal retry suppression

Does not belong here:

- raw `fs.rm()` calls spread across service branches
- workspace path derivation details
- tracker transport logic

### Execution Layer

Belongs here:

- deterministic workspace path ownership
- workspace reset/reuse behavior for retries through `prepareWorkspace()`
- cleanup execution primitives and normalized cleanup result reporting

Does not belong here:

- deciding which lifecycle outcomes are terminal
- deciding whether failure should be retained or deleted
- status projection rules

### Integration Layer

Belongs here:

- existing normalized tracker lifecycle facts that coordination already uses to decide success, failure, retry suppression, and recovery outcomes

Does not belong here:

- workspace retention state
- cleanup result storage
- provider-specific cleanup policy

This layer should remain unchanged or only minimally touched for compatibility.

### Observability Layer

Belongs here:

- status/action/artifact projection of cleanup posture and result
- structured logs for cleanup requests, policy decisions, and failures

Does not belong here:

- becoming the source of truth for cleanup decisions
- direct filesystem mutation

## Architecture Boundaries

### `src/config/`

Owns:

- typed parsing of the workspace retention policy from `WORKFLOW.md`
- compatibility normalization from legacy `cleanup_on_success`

Does not own:

- runtime cleanup decisions
- per-issue cleanup outcomes

### `src/orchestrator/`

Owns:

- the cleanup/retention policy application
- transition from active/retry/recovered issue states into terminal cleanup or intentional retention
- preserving terminal outcome even when cleanup fails

Does not own:

- `fs.rm()` details
- workspace path sanitization
- tracker transport quirks

### `src/workspace/`

Owns:

- deterministic per-issue workspace path
- cleanup execution and reset/reuse behavior
- returning normalized cleanup results/errors to the orchestrator

Does not own:

- deciding whether a failure is retryable
- deciding whether cleanup should run after a given lifecycle outcome

### `src/observability/`

Owns:

- status snapshot fields or action summaries that make cleanup posture inspectable
- durable artifact/log recording of cleanup decisions where appropriate

Does not own:

- cleanup branching
- retry or recovery policy

## Slice Strategy And PR Seam

This issue should land as one coordination-plus-execution PR with a small observability extension:

1. define the explicit workspace retention policy contract
2. add a focused coordination helper/state seam for cleanup decisions and outcomes
3. update the workspace service to report normalized cleanup results
4. project cleanup posture through status/logs/artifacts just enough to make the policy inspectable
5. add targeted tests across unit/integration/e2e levels

Deferred from this PR:

- time-based janitors or historical workspace rotation
- detached factory wrapper/process cleanup changes
- broader restart-recovery or retry-state refactors unrelated to workspace consequences
- artifact publication/archive policy changes

Why this seam is reviewable:

- it stays centered on one runtime concern: local workspace lifetime after run outcomes
- it avoids mixing tracker transport changes with filesystem policy
- it gives operators a visible cleanup contract without requiring a larger persistence redesign

## Runtime State Machine

This issue changes orchestration behavior around terminal transitions and recovery consequences, so cleanup state must be explicit.

### Per-Issue Workspace Retention States

1. `active`
   - the issue currently owns a live reusable workspace path
2. `retry-retained`
   - the last attempt ended in a retry path; the workspace is intentionally kept and will be reset by the next `prepareWorkspace()` call
3. `terminal-retained`
   - the issue reached a terminal outcome and policy intentionally keeps the workspace for inspection
4. `cleanup-requested`
   - coordination has decided the issue is terminal and cleanup should run
5. `cleanup-succeeded`
   - cleanup finished or the workspace was already absent
6. `cleanup-failed`
   - cleanup threw or could not complete; the issue outcome remains terminal but operator-visible cleanup action is required

Allowed transitions:

- `active -> retry-retained`
- `active -> terminal-retained`
- `active -> cleanup-requested -> cleanup-succeeded`
- `active -> cleanup-requested -> cleanup-failed`
- `retry-retained -> active`
- `retry-retained -> terminal-retained`
- `retry-retained -> cleanup-requested`

Decision notes:

- `retry-retained` is intentional bounded retention, not historical accumulation. The runtime continues to use one deterministic workspace path per issue.
- `cleanup-succeeded` may include the idempotent case where the workspace path is already missing; the policy should not fail solely because cleanup found nothing to delete.

### Policy Rules By Outcome

1. Successful terminal outcome:
   - default to cleanup
   - preserve the terminal tracker/artifact outcome even if cleanup fails
2. Terminal failure:
   - default to retention for inspection
   - do not silently delete the only local execution workspace unless policy explicitly says to do so
3. Retry-scheduled outcome:
   - retain the workspace and rely on `prepareWorkspace()` reset/reuse before the next attempt
4. Restart-recovered terminal success (`handoff-ready` observed during recovery/reconcile):
   - treat like successful terminal completion and apply the same cleanup policy
5. Restart-recovered non-success terminal failure:
   - retain by the failure policy unless future review explicitly chooses otherwise

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| Run reaches terminal success and cleanup policy is `delete` | workspace path, terminal success result | `handoff-ready` / merged terminal lifecycle | mark issue complete, transition to `cleanup-requested`, delete workspace, record `cleanup-succeeded` or `cleanup-failed` |
| Run reaches terminal success and cleanup policy is `retain` | workspace path, terminal success result | `handoff-ready` / merged terminal lifecycle | keep workspace, record `terminal-retained`, do not fabricate cleanup failure |
| Run reaches terminal failure | workspace path, non-retryable or exhausted failure result | issue still active or failed lifecycle | retain workspace for inspection, record `terminal-retained`, then mark tracker failure |
| Run failure is retryable and retry is scheduled | workspace path, retry queue entry | issue still eligible for retry | keep workspace, record `retry-retained`, rely on next `prepareWorkspace()` reset instead of deleting/recloning |
| Restart recovery suppresses rerun because tracker already shows terminal success | workspace may still exist from an inherited run | refreshed lifecycle is terminal success | complete the issue, apply the same terminal-success cleanup policy, surface any cleanup failure separately from the terminal outcome |
| Cleanup is requested but workspace path is already absent | no readable directory at expected path | issue already terminal | treat as idempotent `cleanup-succeeded`; do not fail terminal completion |
| Cleanup throws after terminal outcome was already committed | workspace path, thrown error | issue already terminal in tracker | keep terminal outcome, classify `cleanup-failed`, surface visible status/log/artifact diagnostics |
| Raw issue artifacts exist under `.var/factory/issues/...` while workspace is deleted | artifact paths outside workspace root | issue terminal or historical | preserve artifacts; workspace cleanup must never delete repo-level artifacts |

## Storage And Persistence Contract

- `.tmp/workspaces/<issue>` remains execution state only
- `.var/factory/issues/<issue-number>/...` remains the canonical local evidence that survives workspace cleanup
- the runtime may project cleanup posture in status snapshots and issue artifacts, but it must not create a second durable cleanup database under `.tmp/workspaces/`
- if a focused cleanup state helper is introduced, it should be in-memory coordination state plus derived observability output, not long-lived per-issue JSON files used as control-plane truth

## Observability Requirements

- operators must be able to tell whether a terminal workspace was cleaned, retained by policy, skipped, or failed cleanup
- structured logs should distinguish cleanup decision, cleanup attempt, and cleanup failure
- status surfaces should expose the latest cleanup-related action or per-issue summary without requiring log inspection
- issue artifacts should preserve enough cleanup context that a later report can explain why a workspace no longer exists or why it was intentionally retained

## Implementation Steps

1. Add the issue plan and drive it through the required human review station.
2. Introduce a typed workspace retention policy contract in `src/domain/workflow.ts` and `src/config/workflow.ts`, including compatibility for `workspace.cleanup_on_success`.
3. Extract a focused orchestrator helper/module for cleanup policy application and cleanup outcome classification.
4. Extend the workspace service/local implementation so cleanup returns a normalized result suitable for orchestration and observability.
5. Replace inline success-only cleanup branches in `src/orchestrator/service.ts` with the explicit cleanup/retention seam for:
   - direct successful completion
   - merged-terminal retry suppression
   - terminal failure / retry consequences where policy requires retention reporting
6. Extend status/actions/artifacts/logging to surface cleanup posture.
7. Update docs (`README.md`, workflow/config docs, and any relevant operator guide) to describe the new retention policy.
8. Run local self-review and the required checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, plus relevant integration/e2e coverage.

## Tests And Acceptance Scenarios

### Unit

- workflow parsing/compatibility tests for the new retention policy inputs
- cleanup decision tests for success, failure, retry, and restart-recovered terminal outcomes
- workspace cleanup result classification tests, including missing-path idempotence and thrown errors

### Integration

- orchestrator integration proving terminal success records cleanup posture and still completes when cleanup fails
- orchestrator integration proving terminal failure records intentional retention instead of silent omission
- status/artifact integration proving cleanup posture survives report/status reads without requiring workspace presence

### End-To-End

1. Successful issue with default cleanup policy deletes the workspace but leaves `.var/factory/issues/<issue-number>/...` intact.
2. Failed issue retains the workspace for inspection and surfaces that retention posture to the operator.
3. Retryable failure reuses one workspace path across attempts instead of accumulating attempt directories.
4. Restart recovery finds a terminally merged issue with a leftover workspace and applies the same cleanup policy as a normal success path.
5. Cleanup failure after terminal success leaves the issue complete while surfacing degraded cleanup posture in operator-visible outputs.

## Exit Criteria

- the workspace retention policy is explicit in code, config, docs, and tests
- successful, failed, retried, and restart-recovered terminal runs leave predictable workspace state
- cleanup failures are operator-visible without changing the already-decided issue terminal outcome
- repo-level issue artifacts remain intact after workspace cleanup
- the implementation passes `pnpm typecheck`, `pnpm lint`, `pnpm test`, and relevant integration/e2e coverage

## Deferred To Later Issues Or PRs

- time-based workspace garbage collection or operator-driven prune commands
- multi-host or remote-worker workspace retention policy
- archival/publication of retained workspaces
- detached factory wrapper/process cleanup policy
- any larger retry-state or restart-state redesign not required to express cleanup outcomes cleanly

## Decision Notes

- Keep one deterministic workspace path per issue. Bounded reuse is the answer to retry/recovery retention; per-attempt workspace history is not.
- Treat workspace cleanup as an execution concern invoked by coordination, not as tracker policy and not as an observability-only afterthought.
- Preserve `cleanup_on_success` compatibility only if it cleanly maps to the new policy; do not keep both contracts indefinitely if that would blur ownership.
