# Issue 66 Plan: Linear GraphQL Transport Client

## Status

- plan-ready

## Goal

Refine the existing Linear GraphQL client into a clearly transport-owned seam for polling and tracker writes, with typed raw response helpers, explicit pagination support, and deterministic surfacing of HTTP and GraphQL failures.

## Scope

- keep the Linear GraphQL transport boundary in `src/tracker/linear-client.ts`
- move project-issue pagination traversal into the client instead of leaving it in `LinearTracker`
- add typed transport response shapes for:
  - project lookup
  - paginated project issue reads
  - project issue lookup by number
  - issue update mutations
  - comment creation mutations
- preserve explicit auth/header handling and endpoint configuration for Linear
- make HTTP and GraphQL failures deterministic and distinguishable in tests
- add focused client coverage for:
  - successful requests
  - multi-page issue polling
  - GraphQL error payloads
  - transport / HTTP failures

## Non-goals

- changing Linear normalization rules in `src/tracker/linear-normalize.ts`
- changing Linear lifecycle/workpad policy in `src/tracker/linear-policy.ts` or `src/tracker/linear-workpad.ts`
- changing orchestrator retry, dispatch, or handoff behavior
- redesigning the generic tracker contract
- expanding the mock Linear schema beyond what current reads/writes require
- depending on a real Linear workspace or external network in tests

## Current Gaps

- `src/tracker/linear-client.ts` exists, but its public methods mostly return `unknown` instead of typed transport payloads
- `src/tracker/linear.ts` currently owns the page-traversal loop for project issue polling, so pagination leaks above the transport boundary
- current tests exercise Linear mostly through `LinearTracker`, not through a dedicated client contract surface
- GraphQL and HTTP failures are surfaced through `TrackerError`, but the client contract is not yet the clearly test-owned seam for those failure classes
- the broader Linear slice from issue `#70` is already merged, so this issue should land as a narrow transport-hardening refactor rather than reopening normalization or policy review surfaces

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: documenting that this issue stays transport-only and does not alter Linear lifecycle policy
  - does not belong: ready/running/failed classification or workpad semantics
- Configuration Layer
  - belongs: reusing the existing validated Linear config fields for endpoint and API key resolution
  - does not belong: reparsing workflow config inside the client
- Coordination Layer
  - belongs: no changes in this slice
  - does not belong: pagination cursors, GraphQL operation names, or HTTP error handling
- Execution Layer
  - belongs: no changes in this slice
  - does not belong: tracker transport concerns
- Integration Layer
  - belongs: GraphQL transport, request helpers, typed raw payloads, pagination traversal, and mutation/query boundary handling
  - does not belong: normalization into `RuntimeIssue` or tracker lifecycle decisions
- Observability Layer
  - belongs: clear, deterministic error messages and test assertions for HTTP and GraphQL failure classes
  - does not belong: new status surfaces or orchestrator-facing telemetry redesign

## Architecture Boundaries

### Belongs in this issue

- `src/tracker/linear-client.ts`
  - GraphQL documents and operation names
  - authenticated request helper
  - typed raw response contracts
  - explicit multi-page polling helper
  - clear HTTP / GraphQL error handling
- `src/tracker/linear.ts`
  - only the narrow call-site changes needed to consume the refactored client API
- `tests/integration/`
  - dedicated Linear client contract tests
  - small tracker adjustments only where client method signatures change
- `tests/support/mock-linear-server.ts`
  - only the harness changes needed to assert client transport behavior or inject failures more directly

### Does not belong in this issue

- moving normalization into the client
- adding policy branches in the orchestrator
- mixing workpad or lifecycle updates into client abstractions
- broad changes across tracker factory, workspace, runner, or status surfaces
- a single hot file that mixes transport, normalization, and policy concerns

## Slice Strategy And PR Seam

This issue fits in one reviewable PR because it narrows the Linear surface rather than extending it:

1. make `LinearClient` the explicit owner of GraphQL request typing and page traversal
2. update `LinearTracker` to consume those helpers without changing policy behavior
3. add focused transport tests so future Linear work can depend on a stable client seam

This slice deliberately defers:

- any new Linear workflow policy
- any tracker-contract redesign
- any orchestrator or runtime-state changes
- any end-to-end behavior beyond preserving the already-landed Linear path

## Runtime State Model

Not applicable for this slice. The work is transport-only and does not change orchestrator retries, continuations, reconciliation, leases, or handoff states.

## Failure-Class Matrix

| Observed condition                                               | Local facts available                                        | Expected client behavior                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| request cannot reach the Linear endpoint                         | operation name, endpoint, thrown fetch error                 | throw `TrackerError` naming the operation and transport failure         |
| Linear returns non-2xx HTTP status                               | operation name, status code, response body text if available | throw `TrackerError` naming the operation and HTTP status               |
| Linear returns `errors` in a 200 GraphQL payload                 | operation name, GraphQL error messages                       | throw `TrackerError` naming the operation and GraphQL error text        |
| Linear returns no `data` field and no GraphQL errors             | operation name, parsed JSON payload                          | throw `TrackerError` naming the missing data payload                    |
| page response reports `hasNextPage: true` with a usable cursor   | current page payload                                         | continue fetching subsequent pages in the client helper                 |
| page response reports `hasNextPage: true` with `endCursor: null` | current page payload                                         | stop defensively and return accumulated results without looping forever |

## Storage / Persistence Contract

- no new durable storage is introduced
- the client continues to use only in-memory request/response values
- remote Linear state remains the system of record for issue/project payloads
- test fixtures remain in the in-process mock Linear server

## Observability Requirements

- error messages must include the GraphQL operation name
- tests must cover HTTP failure and GraphQL failure as distinct classes
- request-history assertions should prove that pagination is driven by the client rather than the tracker
- call sites above the client should not need to inspect raw GraphQL envelopes to decide whether a transport failure occurred

## Implementation Steps

1. Refactor `src/tracker/linear-client.ts` to define explicit raw transport types for the supported queries and mutations.
2. Add a client-owned helper for paginated project issue polling that performs the cursor loop internally.
3. Keep the low-level request method responsible for auth headers, endpoint calls, HTTP handling, GraphQL error handling, and missing-data validation.
4. Narrow `src/tracker/linear.ts` so it consumes typed client helpers instead of looping through cursors itself.
5. Add focused integration tests for the client covering:
   - successful project lookup
   - successful multi-page project issue polling
   - GraphQL error payloads
   - HTTP failure payloads
   - defensive stop when `hasNextPage` is true but `endCursor` is `null`
6. Preserve or lightly update tracker integration coverage only where it protects the unchanged higher-level behavior.
7. Run repo gates and self-review before opening the PR.

## Tests And Acceptance Scenarios

### Integration

- `LinearClient.fetchProject()` sends the expected auth header and returns the typed project payload
- `LinearClient.fetchProjectIssues()` traverses all pages and returns accumulated typed issue payloads
- `LinearClient.fetchProjectIssue()` returns a typed issue lookup payload
- `LinearClient.updateIssue()` and `LinearClient.createComment()` return typed mutation payloads
- GraphQL errors are surfaced distinctly from HTTP failures
- pagination stops defensively when the API claims another page but omits the cursor

### Regression

- `LinearTracker.fetchReadyIssues()` still returns the same normalized issue numbers after the client refactor
- existing Linear tracker writes still succeed against the mock server

### Repo Gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main`

## Acceptance Scenarios

1. The client can fetch all paginated project issues from the mock Linear GraphQL server without the tracker owning the cursor loop.
2. The client can fetch a single project-scoped issue and return a typed raw payload to normalization code.
3. The client can perform issue-update and comment-create mutations with the configured Linear auth header.
4. A GraphQL `errors` payload fails deterministically with an operation-specific `TrackerError`.
5. A non-2xx HTTP response fails deterministically with an operation-specific `TrackerError`.
6. Existing tracker behavior remains unchanged apart from consuming the narrower transport API.

## Exit Criteria

- `LinearClient` is the transport owner for Linear GraphQL requests and project-issue pagination
- supported client methods return typed raw payloads instead of `unknown`
- HTTP and GraphQL failures are covered directly in client-focused tests
- `LinearTracker` no longer owns the cursor loop for paginated issue polling
- the change lands as one reviewable PR without reopening normalization or lifecycle-policy concerns

## Deferred To Later Issues Or PRs

- further normalization tightening inside `src/tracker/linear-normalize.ts`
- lifecycle/workpad policy changes
- broader tracker service redesign
- additional Linear operations beyond the current polling and write needs
- richer observability surfaces beyond error clarity at the transport seam

## Decision Notes

- The client should return typed raw transport payloads, not normalized runtime models. That keeps parsing at the boundary while preserving the transport/normalization split.
- Pagination belongs in the client because cursor traversal is a transport concern, while issue classification belongs in the tracker because it is policy.
- This issue should not duplicate the broader Linear work already merged through issue `#70`; it should tighten the transport seam that broader slice currently depends on.

## Revision Log

- 2026-03-10: Initial plan created and marked `plan-ready` for issue #66.
