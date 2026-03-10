# Issue 67 Plan: Linear Issue Snapshot Normalization

## Status

- approved

## Goal

Normalize Linear GraphQL issue payloads into stable TypeScript tracker snapshots that match the upstream Elixir Linear issue shape where it is relevant to orchestration, while keeping raw GraphQL response structure and relation decoding inside the Linear adapter boundary.

## Scope

- expand the Linear read payload seam so the transport layer exposes the raw issue fields needed for normalization:
  - `id`
  - `identifier`
  - `number`
  - `title`
  - `description`
  - `priority`
  - `state`
  - `branchName`
  - `url`
  - assignee identity
  - labels
  - dependency / blocked-by relations
  - `createdAt`
  - `updatedAt`
- normalize those raw fields into a richer `LinearIssueSnapshot` in `src/tracker/linear-normalize.ts`
- preserve a tracker-neutral `RuntimeIssue` projection for the orchestrator without leaking raw Linear payload envelopes upward
- add assignee-routing compatibility at the normalization boundary so the adapter can tell whether an issue is assigned to the configured worker
- add focused tests for:
  - partial payloads
  - dependency decoding
  - labels
  - timestamps
  - assignee routing behavior

## Non-goals

- adding Linear tracker writes or new state-mutation behavior
- changing Linear lifecycle or workpad policy in `src/tracker/linear-policy.ts`
- redesigning the generic `Tracker` interface or orchestrator runtime state
- moving normalization logic into `src/tracker/linear-client.ts`
- adding tracker writes for dependencies, labels, assignees, or branches
- implementing viewer-resolution support such as a new `me` GraphQL lookup unless the checked-in config contract already requires it

## Current Gaps

- `src/tracker/linear-normalize.ts` currently normalizes only a narrow subset of the issue payload and drops `priority`, `branchName`, assignee identity, labels, and relations
- the current `LinearIssueSnapshot` does not expose normalized blocked-by or dependency data, so policy above the transport seam cannot reason over stable relation snapshots later
- `RuntimeIssue` is intentionally tracker-neutral, but the current normalization path does not clearly separate adapter-only fields from the generic issue projection
- `src/tracker/linear-client.ts` query documents and raw types do not yet request or expose all fields needed for issue-67 normalization
- `tests/support/mock-linear-server.ts` does not yet model the extra raw fields this slice needs to normalize
- unit coverage currently only asserts one missing-project failure path in `tests/unit/linear-normalize.test.ts`

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: documenting that the Linear adapter should produce a stable snapshot with assignee-routing facts and decoded blocker relations
  - does not belong: changing ready/running/failed/completed policy or workpad semantics in this issue
- Configuration Layer
  - belongs: reusing the existing checked-in Linear config contract, especially `tracker.assignee`
  - does not belong: reparsing workflow front matter or inventing a second assignee config path inside the tracker
- Coordination Layer
  - belongs: no changes in this slice
  - does not belong: GraphQL shape handling, relation decoding, or assignee identity parsing
- Execution Layer
  - belongs: no changes in this slice
  - does not belong: tracker payload normalization
- Integration Layer
  - belongs: raw Linear query field selection, tracker-owned normalization, assignee routing interpretation, and blocked-by decoding
  - does not belong: orchestrator retries, handoff policy, or generic runtime-state transitions
- Observability Layer
  - belongs: clear normalization failures with field-specific paths, plus tests that prove partial payload handling
  - does not belong: new operator dashboards or orchestration status surfaces

## Architecture Boundaries

### Belongs in this issue

- `src/tracker/linear-client.ts`
  - only the raw GraphQL fields and TypeScript transport types needed so normalization can see the required data
  - no tracker policy or relation interpretation beyond faithfully exposing the response shape
- `src/tracker/linear-normalize.ts`
  - the normalized `LinearIssueSnapshot` contract
  - assignee normalization and configured-worker matching
  - label normalization
  - relation decoding into a stable adapter snapshot
  - timestamp parsing / preservation rules at the adapter boundary
- `src/tracker/linear.ts`
  - only the minimal call-site changes needed to pass config or consume the richer normalized snapshot
- `tests/unit/linear-normalize.test.ts`
  - the main contract tests for issue normalization
- `tests/support/mock-linear-server.ts`
  - only the mock schema and fixture helpers needed to supply the new raw read fields

### Does not belong in this issue

- moving tracker relation policy into the orchestrator
- teaching workspace or runner layers anything about Linear
- coupling the generic `RuntimeIssue` shape to Linear-only fields unless a field is truly tracker-neutral and already needed above the adapter
- mixing transport request execution and normalization logic in one file
- broad end-to-end harness changes unrelated to the normalization seam

## Slice Strategy And PR Seam

This issue stays one reviewable PR by landing one adapter-boundary slice:

1. extend the Linear read transport shape only enough to expose the raw fields needed for normalization
2. normalize those fields into a stable `LinearIssueSnapshot`
3. keep the orchestrator-facing `RuntimeIssue` projection narrow
4. prove the contract with focused unit and mock-backed integration coverage

This seam is reviewable on its own because it improves the adapter boundary without reopening lifecycle policy, tracker writes, or orchestrator control flow.

Deferred from this PR:

- any new lifecycle decisions that act on dependencies
- any tracker writes for relations or assignees
- any shared-domain redesign larger than the minimal projection needed for current callers

## Runtime State Model

Not applicable for this slice. The work is normalization-only and does not change retries, continuations, reconciliation, leases, or handoff states.

## Failure-Class Matrix

| Observed condition                                                   | Local facts available                           | Normalized tracker facts available | Expected behavior                                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| optional Linear field is missing or `null`                           | raw issue payload path                          | none yet                           | normalize to `null`, empty list, or a documented default when the field is optional                                                    |
| required core field such as `id` or `identifier` is missing          | raw issue payload path                          | none yet                           | throw `TrackerError` with the field path                                                                                               |
| relation entry exists but is not a `blocks`-style inverse relation   | raw relation type plus relation issue payload   | none yet                           | ignore that relation for blocked-by normalization                                                                                      |
| relation entry is malformed                                          | raw relation node path                          | partial issue snapshot             | ignore the malformed relation if it is optional, or fail only when a required nested field is missing for an accepted blocker relation |
| configured `tracker.assignee` is absent                              | workflow config                                 | issue assignee snapshot            | mark `assignedToWorker` as `true` without filtering away the issue                                                                     |
| configured `tracker.assignee` is present and issue assignee is empty | workflow config plus normalized assignee fields | issue assignee snapshot            | mark `assignedToWorker` as `false`                                                                                                     |
| configured `tracker.assignee` is present and issue assignee matches  | workflow config plus normalized assignee fields | issue assignee snapshot            | mark `assignedToWorker` as `true`                                                                                                      |
| timestamp field is present but not valid ISO-8601                    | raw timestamp string                            | raw string preserved if needed     | keep the raw string on the snapshot field and avoid throwing unless the field is required to parse into a stricter type                |

## Storage / Persistence Contract

- no new durable storage is introduced
- the normalized Linear issue snapshot remains in-memory tracker state
- local issue artifacts and orchestrator state remain unchanged in this slice
- remote Linear issue/project payloads remain the external source of truth for tracker facts

## Observability Requirements

- normalization errors must include the failing field path
- tests must prove how partial payloads behave instead of leaving optionality implicit
- the adapter should expose enough normalized data for later policy or recovery work without requiring callers to inspect raw GraphQL envelopes

## Implementation Steps

1. Update `src/tracker/linear-client.ts` raw issue types and GraphQL field selections to include the additional read-only fields needed by normalization.
2. Extend `tests/support/mock-linear-server.ts` so mock issue payloads can emit assignee identity, labels, branch names, priorities, and inverse relation nodes.
3. Refactor `src/tracker/linear-normalize.ts` to define stable normalized types for:
   - assignee snapshot
   - blocked-by / dependency relation snapshot
   - richer issue snapshot fields aligned with the Elixir reference
4. Add a normalization entry point that can evaluate configured assignee routing without moving that logic into the transport client.
5. Keep or adjust the `RuntimeIssue` projection so higher layers receive only tracker-neutral fields they already rely on.
6. Update `src/tracker/linear.ts` call sites to consume the new normalization contract with minimal policy change.
7. Add focused unit coverage for the normalization contract and one small mock-backed regression test if needed to prove the client/normalizer seam.
8. Run repo gates and self-review before opening the PR.

## Tests And Acceptance Scenarios

### Unit

- normalizes a representative Linear issue payload into a stable `LinearIssueSnapshot`
- preserves `priority`, `branchName`, `createdAt`, and `updatedAt`
- lowercases or otherwise normalizes labels consistently with the upstream reference
- decodes only `blocks` inverse relations into `blockedBy`
- tolerates missing optional sub-objects such as `assignee`, `labels`, or relations
- marks `assignedToWorker` correctly for:
  - no configured assignee
  - matching configured assignee
  - non-matching configured assignee
- fails clearly when required root fields are missing

### Integration

- `LinearTracker.fetchReadyIssues()` still returns the same `RuntimeIssue` projection after the richer snapshot lands
- mock Linear reads can carry the added raw fields without leaking raw GraphQL structure above normalization

### Repo Gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main`

## Acceptance Scenarios

1. Given a representative Linear GraphQL issue payload with assignee, labels, branch name, priority, and inverse relations, the adapter produces a stable normalized snapshot without exposing raw `nodes`/GraphQL envelope structures to callers.
2. Given a payload with missing optional assignee, label, or relation fields, normalization succeeds with documented defaults instead of throwing.
3. Given a payload with malformed required fields, normalization fails with a field-specific `TrackerError`.
4. Given a configured Linear assignee filter, normalization marks whether the issue is assigned to the configured worker in a way compatible with the existing config contract.
5. Given inverse relations containing non-blocking relation types, only blocking relations are surfaced in the normalized blocked-by list.

## Exit Criteria

- the Linear adapter exposes a richer normalized issue snapshot aligned with the upstream Elixir Linear issue fields relevant to this repo
- raw GraphQL transport structures remain confined to `src/tracker/linear-client.ts`
- assignee routing, labels, and blocker decoding are covered by tests
- tracker callers above normalization continue to consume a stable tracker-neutral issue projection
- the change lands as one reviewable PR without bundling tracker writes or lifecycle-policy changes

## Deferred To Later Issues Or PRs

- using normalized dependencies to change dispatch or recovery decisions
- viewer-based `tracker.assignee: me` resolution if the config contract expands to require it
- tracker writes for dependency or assignee changes
- any orchestrator/domain redesign driven by richer tracker-neutral issue metadata
- richer end-to-end Linear scenarios that depend on blocker-aware policy

## Decision Notes

- The richer Linear shape should live in `LinearIssueSnapshot`, not in the generic orchestrator-facing `RuntimeIssue`, unless a field is clearly tracker-neutral and needed across adapters.
- Extending the client query fields is part of this issue only as support work for normalization. Interpretation of those raw fields must remain in `src/tracker/linear-normalize.ts`.
- Assignee-routing compatibility should reuse the checked-in config contract exactly as it exists today. This issue should not speculate about new workflow keywords or upstream viewer lookups unless later requirements force that expansion.

## Revision Log

- 2026-03-10: Initial plan created and marked `plan-ready` for issue #67.
- 2026-03-10: Plan approved on the issue thread; implementation proceeded on the approved slice.
