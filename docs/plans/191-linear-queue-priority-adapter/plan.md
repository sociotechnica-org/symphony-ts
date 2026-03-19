# Issue 191 Plan: Linear Adapter For Tracker-Native Queue Priority

## Status

- plan-ready

## Goal

Add a Linear tracker adapter seam that maps Linear-native issue priority into Symphony's normalized `issue.queuePriority` contract so Linear-backed queues can participate in the shared queue-priority ordering model without leaking Linear schema into the orchestrator.

## Scope

- reuse the existing Linear issue transport field for native priority rather than adding new Linear API queries
- extend Linear tracker config validation only as needed to keep the existing `tracker.queue_priority.enabled` seam explicit and well documented
- normalize Linear priority values into the tracker-neutral `QueuePriority` contract inside the Linear adapter boundary
- populate normalized `queuePriority` on `RuntimeIssue` values returned by Linear tracker reads
- add focused unit and mock-backed integration coverage for configured, disabled, unset, and invalid Linear priority cases
- update docs to explain the Linear queue-priority seam and its fallback behavior

## Non-goals

- changing orchestrator dispatch order in this issue
- changing the tracker-neutral `QueuePriority` contract from issue `#192`
- GitHub queue-priority work beyond staying compatible with the existing contract
- redesigning existing Linear active, terminal, review, or handoff lifecycle behavior
- introducing new Linear transport endpoints, broader GraphQL refactors, or status/report redesign
- combining Linear queue priority with retries, leases, reconciliation, or landing policy

## Current Gaps

- `src/tracker/linear-normalize.ts` already validates Linear native `priority` into the adapter snapshot, but `runtimeIssue.queuePriority` is still hard-coded to `null`
- `LinearTracker` therefore drops tracker-native ordering metadata even when the repo opts into queue priority
- the current Linear workflow config only preserves `tracker.queue_priority.enabled`; the adapter does not yet consume that switch to populate normalized queue-priority facts
- README and `WORKFLOW.md` document the GitHub queue-priority seam, but do not yet explain the Linear-native mapping path
- existing Linear tests lock in `queuePriority: null`, which means the queue-priority contract is not yet proven for Linear-backed queues

## Decision Notes

- Keep the slice at the Linear integration boundary. Linear already returns native `priority`, so this issue should not add transport complexity that the current GraphQL payload does not require.
- Preserve the tracker-neutral runtime contract from `#192`; only normalized `rank` and optional `label` should cross the tracker boundary.
- Treat Linear `priority: 0` and `priority: null` as unset and degrade to `queuePriority: null` so ready work stays eligible and deterministic fallback ordering remains intact.
- Keep Linear-specific mapping policy in focused normalization helpers instead of spreading it across `linear.ts`, workflow parsing, and tests.
- Stay reviewable as one PR by limiting the slice to config consumption, normalization, tests, and docs.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining how Linear-native priority populates the existing normalized ordering hint
  - belongs: documenting fallback semantics for disabled, missing, or unset Linear priority
  - does not belong: orchestrator queue-order changes or raw Linear schema outside the tracker boundary
- Configuration Layer
  - belongs: preserving the explicit `tracker.queue_priority.enabled` opt-in for Linear
  - does not belong: embedding Linear normalization rules inside workflow parsing beyond the typed config seam
- Coordination Layer
  - belongs: no behavioral changes in this slice beyond continuing to consume normalized `RuntimeIssue`
  - does not belong: raw Linear priority parsing or adapter-specific fallback logic
- Execution Layer
  - belongs: no changes
  - does not belong: tracker-native priority metadata or queue-order policy
- Integration Layer
  - belongs: Linear normalization from native priority into `QueuePriority`, plus adapter-owned fallback behavior
  - does not belong: leaking Linear integer enum details into `src/domain/` or `src/orchestrator/`
- Observability Layer
  - belongs: docs and tests that keep normalized queue-priority facts inspectable for later projection
  - does not belong: a broader TUI, report, or status-surface redesign in this slice

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - retain the Linear queue-priority config seam and tighten the type only if the current generic shape is insufficient for explicit Linear adapter consumption
- `src/config/workflow.ts`
  - validate and resolve Linear queue-priority config exactly at the workflow boundary
- `src/tracker/linear-normalize.ts`
  - add focused Linear priority normalization into `runtimeIssue.queuePriority`
  - keep raw Linear priority handling and fallback behavior localized here or in a small adjacent helper
- `src/tracker/linear.ts`
  - consume the normalized issue contract without reinterpreting Linear-native fields
- Linear unit and integration tests plus concise docs updates

### Does not belong in this issue

- orchestrator ordering changes
- GitHub adapter changes
- new Linear transport or pagination behavior unrelated to queue priority
- lifecycle-policy changes for claim, human review, rework, merge, or terminal handling
- status/report/TUI work centered on queue-priority display
- mixing Linear transport, normalization, and orchestrator policy in one broad patch

## Layering Notes

- `config/workflow`
  - owns parsing and validation of the optional Linear queue-priority config seam
  - does not inspect live Linear issue payloads
- `tracker`
  - owns Linear priority normalization and fallback to `queuePriority: null`
  - does not require the orchestrator to know Linear's `0-4` native range
- `workspace`
  - untouched
  - does not carry tracker queue metadata
- `runner`
  - untouched
  - does not participate in queue-priority mapping
- `orchestrator`
  - untouched in behavior
  - continues to consume normalized issues only
- `observability`
  - may project normalized `queuePriority` later
  - is not the source of truth for Linear priority semantics

## Slice Strategy And PR Seam

This issue fits in one reviewable PR by keeping the change inside the Linear tracker edge:

1. consume the existing `tracker.queue_priority.enabled` seam for Linear
2. normalize Linear native `priority` into `issue.queuePriority`
3. prove fallback behavior with unit and mock-backed integration tests
4. document the Linear configuration and normalization path

This avoids combining:

- orchestrator dispatch-policy changes
- new Linear API transport work
- GitHub queue-priority behavior
- broader observability or lifecycle refactors

## Runtime State Model

Not applicable for this slice. The issue changes tracker-boundary normalization, not retries, continuations, reconciliation, leases, or handoff states.

## Failure-Class Matrix

| Observed condition                                                   | Local facts available                        | Normalized tracker facts available     | Expected behavior                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| Linear queue-priority config is absent                               | resolved tracker config                      | native priority may exist              | preserve current behavior; normalize `queuePriority: null`                        |
| Linear queue-priority config is present with `enabled: false`        | resolved tracker config                      | native priority may exist              | normalize `queuePriority: null`                                                   |
| Linear queue-priority config is present with `enabled: true`         | resolved tracker config                      | native priority integer or null        | map supported native priority into normalized `QueuePriority`                     |
| Linear issue priority is `0` or `null`                              | resolved tracker config                      | native priority unset                  | normalize `queuePriority: null`                                                   |
| Linear issue priority is in the supported `1-4` range               | resolved tracker config                      | native priority integer                | normalize to a stable `rank` and human-readable `label` inside the tracker layer  |
| Linear issue priority is outside the supported range or not integer | normalization field path                     | malformed raw Linear payload           | fail at the Linear normalization boundary; do not leak malformed priority upward   |
| Two issues have different normalized Linear-derived priorities       | normalized runtime issues                    | populated `queuePriority` values       | shared queue-priority comparator can order them without Linear-specific knowledge  |
| Linear issue is otherwise readable but priority mapping is disabled  | tracker config, issue identity               | native priority ignored by policy seam | issue remains readable; no lifecycle or eligibility behavior changes              |

## Storage / Persistence Contract

- no new durable local storage
- Linear native priority remains adapter-local transport data
- only the normalized `issue.queuePriority` contract crosses into the runtime domain
- existing issue snapshots, status payloads, and reports remain unchanged unless they already carry normalized issue metadata

## Observability Requirements

- config validation errors must continue to identify malformed `tracker.queue_priority` input clearly
- tests should lock in the fallback contract for disabled or unset Linear priority
- docs should state that Linear uses native priority normalization and falls back to `null` when disabled or unset

## Implementation Steps

1. Confirm the current Linear workflow config seam is sufficient; narrow any type/config change to the minimum needed for explicit Linear adapter consumption.
2. Add a focused Linear queue-priority normalization helper or adjacent normalization path that maps supported native priority values into the shared `QueuePriority` contract.
3. Thread that normalized value into `runtimeIssue.queuePriority` in `normalizeLinearIssueSnapshot()` only when Linear queue priority is enabled.
4. Keep existing Linear snapshot fields stable so active/terminal/handoff policy continues to use the same adapter snapshot inputs as before.
5. Add unit coverage for:
   - disabled Linear queue priority
   - enabled mapping for supported `1-4` native priorities
   - fallback to `null` for `0` and `null`
   - clear failure on malformed native priority values
6. Add mock-backed integration coverage proving Linear tracker reads populate normalized `queuePriority` when enabled and preserve `null` when disabled or omitted.
7. Update `README.md` and `WORKFLOW.md` comments with the Linear configuration seam and fallback semantics.
8. Run local self-review plus repo checks before PR creation.

## Tests And Acceptance Scenarios

### Unit

- workflow parsing accepts omitted Linear queue-priority config
- workflow parsing accepts explicit disabled Linear queue-priority config
- Linear normalization maps supported native priorities into stable normalized `rank` and `label` facts when enabled
- Linear normalization falls back to `null` for disabled config, `priority: 0`, and `priority: null`
- malformed native priority values still fail clearly at the normalization boundary

### Integration

- mock-backed Linear tracker reads return populated normalized queue priority when `tracker.queue_priority.enabled: true`
- Linear tracker reads still return `queuePriority: null` when Linear queue priority is omitted or disabled
- existing Linear ready/running/failed issue reads remain otherwise unchanged

### Repo Gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- local self-review when a reliable review command is available

## Acceptance Scenarios

1. Given a Linear tracker config with queue priority omitted, Linear issues continue to normalize with `queuePriority: null`.
2. Given a Linear tracker config with `queue_priority.enabled: false`, Linear issues still normalize with `queuePriority: null` even when native priority is present.
3. Given a Linear tracker config with `queue_priority.enabled: true` and an issue whose native priority is in Linear's supported `1-4` range, `fetchReadyIssues()` returns that issue with populated normalized queue priority.
4. Given enabled Linear queue priority and an issue whose native priority is `0` or `null`, the issue remains readable and normalizes to `queuePriority: null`.
5. Given malformed native Linear priority outside the supported range, normalization fails clearly at the tracker boundary.
6. Given Linear-derived normalized priorities on returned issues, the shared queue-priority comparator can order them without any Linear-specific input.

## Exit Criteria

- Linear tracker config exposes an explicit, documented queue-priority opt-in that the adapter actually consumes
- Linear adapter normalizes native priority into tracker-neutral `issue.queuePriority` when enabled
- disabled or unset Linear priority degrades to `queuePriority: null`
- tests cover supported normalization and fallback paths using the existing mock Linear harness
- the PR stays limited to the Linear tracker boundary and required docs/tests

## Deferred To Later Issues Or PRs

- orchestrator queue ordering changes that actively prioritize ready work by `queuePriority`
- richer observability or status/report projection of queue-priority metadata
- any Linear transport expansions unrelated to native priority normalization
- any cross-tracker policy that combines queue priority with retries, pressure, or handoff state
- any redesign of existing Linear active or terminal lifecycle handling

## Revision Log

- 2026-03-19: Initial draft created for issue `#191` and marked `plan-ready`.
