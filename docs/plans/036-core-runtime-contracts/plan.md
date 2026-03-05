# Phase 1 Technical Plan: Core Runtime Contracts

## Goal

Refactor the working Phase 0 prototype into a clean, spec-aligned runtime core that can support Beads without architectural churn.

The main deliverable is not a new feature. It is a stable set of runtime contracts and state transitions that future phases can safely extend.

## Success Criteria

1. The runtime core reflects the Symphony model closely enough that the spec remains the primary design reference.
2. Tracker, runner, and workspace implementations are all behind explicit service contracts.
3. The orchestrator owns a single runtime state model for dispatch, retries, running sessions, and reconciliation.
4. Phase 0 behavior still works after the refactor.
5. Beads can be added in Phase 2 without redefining the core interfaces.

## Design Objectives

- Keep the core runtime tracker-agnostic.
- Keep the orchestrator stateful and explicit.
- Push external-system quirks to adapters.
- Avoid magical abstractions that make agent maintenance harder.
- Encode operational behavior in typed contracts and tests.

## Contract Surface

### 1. Normalized Issue Model

Define a stable issue shape with enough fields for both GitHub and Beads:

- `id`
- `identifier`
- `title`
- `description`
- `priority`
- `state`
- `labels`
- `branchName`
- `url`
- `blockedBy`
- `createdAt`
- `updatedAt`
- `trackerMetadata`

The adapter can hold raw extras internally, but the orchestrator should consume one normalized model.

### 2. Workflow / Config Contract

Split workflow responsibilities:

- raw file loader
- front matter parser
- template renderer
- typed config resolver

Configuration outputs should include:

- tracker kind and tracker config
- polling interval
- concurrency
- workspace root and hooks
- agent runner config
- retry settings

### 3. Tracker Service

Target contract:

- `fetchEligibleIssues`
- `getIssue`
- `getIssuesByIds`
- `claimIssue`
- `releaseIssue` or `markFailed`
- `completeIssue`
- `listTerminalIssuesForCleanup` if needed

Not every backend must implement every mutation identically, but the service shape should support orchestration and reconciliation.

### 4. Workspace Service

Target contract:

- `ensureWorkspace`
- `getWorkspace`
- `cleanupWorkspace`
- optional workspace lifecycle hooks

Returned workspace info should include:

- absolute path
- workspace key
- whether it was created during this call

### 5. Runner Service

Target contract:

- `launch`
- `stop`
- `status`

Preferred output model:

- stream or callback-based event flow for live status
- final run result with exit status and summary

Phase 1 does not require multiple runners, but it should stop assuming a shell command is the whole model.

### 6. Observability Service

Target contract:

- structured logging
- spans / operation boundaries
- session-aware annotations

This should remain thin. Do not build a logging framework inside the app.

## Orchestrator Runtime Model

Define explicit in-memory state:

- current poll interval
- max concurrency
- running issues
- claimed issues
- retry queue
- completed bookkeeping
- session metadata

The orchestrator should own transitions for:

1. poll
2. eligibility filter
3. dispatch
4. run start
5. run success
6. run failure
7. retry scheduled
8. reconciliation
9. shutdown

## Required Refactors From Phase 0

### 1. Pull prompt-building out of the runner boundary

Prompt rendering belongs to workflow/config logic, not to the shell runner.

### 2. Stop encoding tracker policy in orchestrator logic

The orchestrator should ask the tracker to claim/complete/release, not manipulate labels or state conventions directly.

### 3. Separate workspace creation from workspace population

This makes reuse, hooks, and future remote runners less messy.

### 4. Distinguish launch failures from run failures

The runtime should know whether:

- the runner could not start,
- the agent started and failed,
- the issue became ineligible while running,
- or the orchestrator itself is shutting down.

### 5. Separate terminal success from workflow handoff

The Symphony spec does not require every success path to mean “done forever.” The contract should allow a tracker-specific completion policy or handoff state.

## Testing Plan

### Contract tests

Every service contract gets a reusable test suite against:

- in-memory fakes
- real local implementations where practical

### State machine tests

The orchestrator needs transition-level tests for:

- capacity full
- retry due
- issue becomes ineligible mid-run
- runner timeout
- shutdown while running
- restart with leftover workspace state

### Regression harness

Keep the Phase 0 ouroboros path working while the internals change.

## Proposed Deliverables

```text
src/domain/
  issue.ts
  run.ts
  workflow.ts

src/config/
  load.ts
  parse.ts
  resolve.ts

src/orchestrator/
  service.ts
  state.ts
  transitions.ts
  loop.ts

src/tracker/
  service.ts
  github-bootstrap.ts
  testing.ts

src/workspace/
  service.ts
  local.ts

src/runner/
  service.ts
  local.ts
  events.ts
```

Again, this is a suggested breakdown, not a rigid prescription.

## Delivery Sequence

1. codify normalized domain types
2. codify workflow/config outputs
3. redefine service interfaces
4. move Phase 0 implementations behind the new interfaces
5. implement explicit orchestrator state and transitions
6. update tests to contract/state-machine style
7. rerun Phase 0 acceptance flow

## Risks

### Refactor freeze temptation

Do not turn Phase 1 into endless abstraction work. The bar is “stable enough for Beads,” not “perfect forever.”

### Over-generalizing before Beads lands

The contracts should be broad enough for Beads, but they should not speculate too far beyond the next phase.

### Effect complexity

Use Effect where it materially improves control flow, retries, resource safety, and testing. Avoid creating a type maze around simple operations.

## Exit Condition

Move to Phase 2 when:

- the runtime contracts are stable,
- the Phase 0 bootstrap flow still works,
- and adding a Beads adapter no longer requires redesigning the orchestrator core.
