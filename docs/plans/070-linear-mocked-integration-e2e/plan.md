# Issue 70 Plan: Linear Mocked Integration And End-to-End Coverage

## Status

- approved

## Goal

Provide a CI-safe Linear GraphQL harness and the smallest real Linear tracker slice that can consume it, so the repository gains mock-backed integration coverage for transport, normalization, writes, and one end-to-end factory loop without depending on a live Linear workspace.

## Scope

- add a reusable in-process mock Linear GraphQL server and fixture builders under `tests/support/`
- add a thin Linear production adapter split across:
  - GraphQL transport/client
  - payload normalization
  - workpad and lifecycle policy
  - tracker implementation
- support the Linear operations required by the current factory contract:
  - project and workflow-state lookup
  - paginated issue reads
  - issue lookup by project and number
  - comment writes
  - issue description updates for a Symphony-owned workpad section
  - issue state transitions
- update tracker factory and the narrow orchestrator seams required to run with `tracker.kind: linear`
- add integration tests for the client and tracker against the mock Linear surface
- add one realistic local-factory e2e scenario against mocked Linear
- document the mock harness contract and the narrow Linear policy choices introduced in this slice

## Non-goals

- reproducing the entire Linear schema or agent-activity surface
- moving Linear-specific workflow policy into the orchestrator core
- redesigning the generic tracker contract beyond the minimum seam needed for Linear
- replacing the existing GitHub mock harness or refactoring unrelated GitHub code
- relying on a real Linear workspace, token, or external network in CI
- introducing tracker-specific storage outside the existing status and issue-artifact contracts

## Current Gaps

- `tracker.kind: linear` loads successfully, but runtime tracker creation still throws
- there is no Linear transport, normalization, or tracker policy implementation in `src/tracker/`
- the orchestrator still assumes GitHub-only tracker metadata for artifact summaries
- the repo has no mock Linear server, no Linear integration tests, and no Linear e2e coverage
- a pure harness-first change would leave the mock without a real production consumer in this branch

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the Linear workpad marker format, readiness/running/failed classification, and handoff mapping kept at the tracker edge
  - does not belong: Linear-specific branching in orchestrator retry or dispatch logic
- Configuration Layer
  - belongs: reusing the existing validated Linear workflow contract
  - does not belong: reparsing raw workflow fields inside the tracker or mock server
- Coordination Layer
  - belongs: only the narrow orchestrator changes needed to stop assuming every tracker is GitHub-shaped
  - does not belong: GraphQL queries, pagination cursors, or Linear state-name rules
- Execution Layer
  - belongs: reusing the existing workspace and local-runner seams in the e2e path
  - does not belong: Linear transport or lifecycle decisions
- Integration Layer
  - belongs: GraphQL transport, normalization, workpad/state policy, tracker mapping, and the mock Linear service
  - does not belong: leaking raw GraphQL payloads upward into orchestrator or prompt logic
- Observability Layer
  - belongs: preserving the existing status snapshot and issue-artifact contracts for Linear runs
  - does not belong: new Linear-only telemetry surfaces unrelated to current runtime correctness

## Architecture Boundaries

### Belongs in this issue

- `src/tracker/linear-client.ts`
  - GraphQL request helper
  - paginated project issue reads
  - issue lookup and write mutations
- `src/tracker/linear-normalize.ts`
  - parse raw GraphQL payloads into typed Linear snapshots and `RuntimeIssue`
- `src/tracker/linear-workpad.ts`
  - render and parse the Symphony-owned issue-description workpad section
- `src/tracker/linear-policy.ts`
  - classify ready/running/failed issues and map Linear issue snapshots into `HandoffLifecycle`
- `src/tracker/linear.ts`
  - implement the `Tracker` contract by composing the modules above
- `tests/support/mock-linear-server.ts`
  - in-memory project/state/issue/comment store
  - GraphQL handlers
  - request-history capture
  - configurable read/write failures
- `tests/integration/`
  - Linear client and tracker tests against the mock harness
- `tests/e2e/`
  - one local factory loop using the real Linear tracker against the mock harness
- small README and plan updates documenting the current Linear seam

### Does not belong in this issue

- one large `src/tracker/linear.ts` that mixes transport, normalization, and policy
- broad orchestrator refactors beyond removing GitHub-only assumptions
- speculative agent-session activity support or OAuth-specific Linear behavior
- workflow-schema redesign outside the already-landed Linear config contract
- fake e2e shortcuts that bypass the tracker service

## Slice Strategy And PR Seam

The approved harness-first plan needs one narrow production consumer to make the issue real. This PR stays reviewable by landing a vertical slice with explicit boundaries:

1. a reusable mock Linear GraphQL harness
2. a thin Linear tracker that satisfies the existing `Tracker` contract
3. integration tests for transport, normalization, writes, and lifecycle mapping
4. one end-to-end factory scenario using the real tracker and existing workspace/runner/orchestrator seams

This remains one reviewable PR because it still defers richer Linear policy:

- no agent-session or webhook support
- no full parity with GitHub PR-based review loops
- no broader tracker-contract redesign
- no extra lifecycle states beyond those required by the current factory handoff model

## Runtime State Model

The supported Linear tracker/runtime states in this slice are:

1. `seeded-ready`
   - issue is in a configured active Linear workflow state and has no active Symphony workpad status
2. `claimed-running`
   - tracker has written the Symphony workpad marker and, when possible, moved the issue into an in-progress active state
3. `retry-scheduled`
   - tracker keeps the issue active, records the retry in comments and the workpad, and exposes it as running rather than ready
4. `failed`
   - tracker records a failure marker in the workpad and exposes the issue via `fetchFailedIssues`
5. `handoff-ready`
   - tracker records a Symphony handoff-ready marker after a successful run
6. `completed`
   - tracker transitions the issue into a terminal Linear state and records final completion notes
7. `transport-or-normalization-failed`
   - GraphQL, HTTP, or boundary parsing prevents progress

Allowed transitions:

- `seeded-ready -> claimed-running`
- `claimed-running -> retry-scheduled`
- `claimed-running -> handoff-ready`
- `retry-scheduled -> claimed-running`
- `claimed-running -> failed`
- `handoff-ready -> completed`
- any read/write state -> `transport-or-normalization-failed`

The orchestrator continues to consume only normalized `RuntimeIssue` values and generalized `HandoffLifecycle` states.

## Failure-Class Matrix

| Observed condition                                           | Local facts available            | Normalized tracker facts available | Expected decision                                                     |
| ------------------------------------------------------------ | -------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| GraphQL page returns `hasNextPage: true` with another cursor | current page and end cursor      | none yet                           | continue pagination until exhaustion                                  |
| GraphQL response includes an `errors` array                  | HTTP success plus GraphQL errors | none                               | raise `TrackerError`; do not accept partial data                      |
| HTTP request fails or times out                              | request error only               | none                               | raise transport failure distinctly from GraphQL errors                |
| required Linear field is missing or malformed                | raw project or issue payload     | partial raw data                   | fail at the normalization boundary                                    |
| workpad mutation targets an unknown issue or workflow state  | mutation variables               | prior normalized issue snapshot    | fail clearly and preserve previous tracker state                      |
| branch name does not map to a valid Linear issue number      | branch name only                 | none                               | return `missing-target` for handoff inspection                        |
| successful run leaves no handoff-ready write                 | normalized issue snapshot        | workpad lacks ready marker         | surface `missing-target` and preserve existing retry/failure behavior |

## Storage / Persistence Contract

- production durability remains unchanged:
  - status snapshots under `.tmp/status.json`
  - issue artifacts under `.var/factory/issues/...`
- Linear-specific ephemeral state lives only in:
  - the remote Linear issue itself via the Symphony workpad section in the description
  - test-only in-memory fixtures inside the mock server
- the workpad format is tracker-edge policy and must stay parseable without orchestrator awareness

## Observability Requirements

- Linear transport failures must stay distinguishable from GraphQL error payloads in tests
- integration tests should assert recorded GraphQL operations and mutation variables
- the mock harness should expose enough request history to debug pagination and write sequencing
- the e2e test should continue asserting the existing factory status and issue-artifact outputs rather than a Linear-only success channel

## Implementation Steps

1. Update this plan to record the narrow scope expansion from pure harness-first to thin real-consumer plus harness.
2. Add `tests/support/mock-linear-server.ts` with:
   - in-memory projects, workflow states, issues, and comments
   - GraphQL handlers for the required queries and mutations
   - request-history capture
   - configurable error injection
3. Add `src/tracker/linear-client.ts` for GraphQL transport and page traversal.
4. Add `src/tracker/linear-normalize.ts` to parse project and issue payloads into stable snapshots.
5. Add `src/tracker/linear-workpad.ts` to manage the Symphony-owned description section used for running/failed/handoff markers.
6. Add `src/tracker/linear-policy.ts` to:
   - classify ready/running/failed issues
   - choose state transitions for claim and completion
   - map issue state and workpad markers into `HandoffLifecycle`
7. Add `src/tracker/linear.ts` and wire `src/tracker/factory.ts` to create it.
8. Remove the narrow GitHub-only assumptions in the orchestrator that block non-GitHub tracker configs, while keeping tracker-specific policy at the edge.
9. Add integration tests for:
   - paginated reads
   - GraphQL error handling
   - normalization and runtime issue mapping
   - comment/workpad writes
   - state transitions and handoff mapping
10. Add one e2e test that loads a Linear workflow config, polls the mock Linear server, runs a local agent, writes tracker updates, and reaches completion.
11. Update minimal docs describing the current Linear test harness and runtime seam.

## Tests And Acceptance Scenarios

### Unit

- `linear-workpad` parser/renderer round-trips the Symphony section without destroying unrelated description content

### Integration

- Linear client follows connection pagination and aggregates project issues deterministically
- GraphQL errors surface as tracker failures distinct from HTTP errors
- tracker claim writes a comment, updates the workpad, and transitions into an in-progress active state when one is available
- tracker retry and failure writes preserve remote state correctly and classify issues as running or failed
- successful reconciliation writes a handoff-ready marker and `inspectIssueHandoff` maps it to `handoff-ready`
- completion moves the issue into a configured terminal state and records the final comment/workpad state

### End-to-End

- a local factory loop can:
  - load `tracker.kind: linear`
  - poll mocked Linear project issues
  - claim a ready issue
  - run the local workspace and agent path
  - write Linear comment/workpad/state updates
  - reach `handoff-ready`
  - complete the issue into a terminal state

### Repo Gate

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main`

## Acceptance Scenarios

1. CI can start a mock Linear GraphQL surface locally and run tests without a real Linear workspace or token.
2. Linear integration tests exercise real GraphQL request/response flow, pagination, normalization, and write mutations against the mock server.
3. `symphony run` can execute at least one realistic local factory loop against `tracker.kind: linear` using the mock Linear server.
4. The orchestrator remains tracker-neutral; Linear-specific lifecycle and workpad policy stay at the tracker edge.

## Exit Criteria

- the repository contains a reusable mock Linear GraphQL harness under `tests/support/`
- the runtime can instantiate a Linear tracker for `tracker.kind: linear`
- Linear transport, normalization, and policy stay split across focused modules
- integration tests cover paginated reads, failure handling, writes, and lifecycle mapping
- at least one e2e factory test runs against mocked Linear with no external dependency

## Deferred To Later Issues Or PRs

- richer Linear agent-session or webhook integration
- non-comment activity surfaces beyond the current workpad/comment contract
- full parity with GitHub review-loop behavior for `awaiting-human-handoff` or `awaiting-system-checks`
- broader tracker-contract changes if future trackers need more handoff metadata than the current generalized lifecycle can express

## Decision Notes

- The original issue ordering expected a harness-first start for `#70`, but the absence of any Linear runtime consumer in this branch makes a pure harness slice too inert. This plan records the smallest real-consumer expansion that keeps the work reviewable.
- The Symphony-owned description workpad keeps Linear-specific state at the tracker edge and avoids teaching the orchestrator how to infer running or failed state from raw Linear comments.
- The e2e path must use the real tracker service. If a scenario cannot be expressed through the public `Tracker` contract and the existing orchestrator/workspace/runner seams, it does not belong in this slice.

## Revision Log

- 2026-03-10: Initial plan created and marked `plan-ready` for issue `#70`.
- 2026-03-10: Plan approved on the issue thread.
- 2026-03-10: Scope updated during implementation to include the thinnest real Linear tracker slice needed to make the mock-backed integration and e2e coverage real in this branch.
