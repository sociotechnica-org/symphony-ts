# Issue 132 Plan

## Goal

Make landing execution exceptions produce an explicit failure artifact outcome instead of reusing `landing-requested`, so artifact consumers, reports, and metrics can distinguish:

- landing request dispatched
- landing blocked by guard/policy
- landing execution or transport failure before dispatch completed

## Scope

- add one explicit landing failure event kind for thrown landing execution paths
- update orchestrator landing artifact creation so exceptions do not emit `landing-requested`
- keep issue artifact summary/outcome inference and markdown timeline rendering coherent with the new event kind
- add regression coverage for unit, observability, and integration/e2e landing-exception paths

## Non-Goals

- changing guarded landing policy rules or `/land` authorization behavior
- redesigning the broader issue artifact schema beyond the minimum taxonomy extension needed here
- changing tracker landing transport behavior except where existing tests need a failure seam
- reworking retry budgets, continuation state, reconciliation, or lease handling

## Current Gaps

- `src/orchestrator/service.ts` currently emits `landing-requested` for every non-blocked landing observation, including exceptions thrown before a request is successfully issued
- `src/observability/issue-artifacts.ts` has no distinct event kind for landing execution failure
- `src/observability/issue-report.ts` assumes every non-blocked landing event means a request was sent and maps `landing-requested` directly to `awaiting-landing`
- existing coverage proves successful and blocked landing paths, but not the thrown-exception artifact semantics called out in the unresolved PR `#123` review thread

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: naming the top-level landing event taxonomy so requested, blocked, and failed outcomes are semantically distinct
  - does not belong: changing merge authorization policy or retry policy
- Configuration Layer
  - belongs: none
  - does not belong: workflow/config fields or parsing changes
- Coordination Layer
  - belongs: the orchestrator branch that converts landing results vs thrown exceptions into durable artifact observations
  - does not belong: broader orchestration-state refactors, retries, or continuation budgeting
- Execution Layer
  - belongs: none beyond treating a thrown `executeLanding()` call as an execution failure signal
  - does not belong: runner or workspace changes
- Integration Layer
  - belongs: preserving the existing tracker contract while testing a transport/execution throw from `executeLanding()`
  - does not belong: mixing transport quirks or GitHub-specific policy into the orchestrator event taxonomy
- Observability Layer
  - belongs: issue artifact event kinds, summary text, report inference, and timeline/status wording
  - does not belong: unrelated report redesign or dashboard changes

## Architecture Boundaries

- Keep the taxonomy change centered in the issue-artifact/issue-report contract, not in tracker-specific code.
- Keep tracker transport, normalization, and policy unchanged for this slice; the orchestrator should react to the normalized `LandingExecutionResult` or thrown exception only.
- Do not introduce a generic boolean-plus-summary bucket for landing outcomes; the top-level event kind must carry the semantic distinction.
- If a shared helper for landing artifact creation is touched, keep it limited to event-kind/outcome selection rather than broad orchestrator restructuring.

## Slice Strategy And PR Seam

This issue should land as one narrow PR:

1. extend the issue-artifact landing event taxonomy with one explicit failure kind
2. update the orchestrator landing exception observation path to emit that kind
3. update issue-report inference/rendering for the new semantics
4. add focused regression coverage

This remains reviewable because it stays inside the landing observability seam. It does not combine guarded-landing policy, transport hardening, or retry-state work.

## Runtime State Model

This issue does not add new runtime states, but it does tighten the mapping between the existing landing execution branch and durable observability outcomes.

- `awaiting-landing-command`
  - PR is clean and waiting for an explicit landing signal
- `awaiting-landing`
  - landing request was actually dispatched and merge observation is pending
- `awaiting-human-review` / `awaiting-system-checks`
  - landing was blocked by normalized policy/guard checks
- `attempt-failed`
  - landing execution threw before request dispatch completed, so the orchestrator records a failed execution path rather than a requested landing

Allowed transitions for this slice:

- `awaiting-landing-command` or `awaiting-landing` + blocked landing result -> artifact event `landing-blocked`, summary outcome matches the normalized lifecycle kind
- `awaiting-landing` + requested landing result -> artifact event `landing-requested`, summary outcome `awaiting-landing`
- `awaiting-landing` + thrown landing exception -> artifact event `landing-failed`, summary outcome `attempt-failed`

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected artifact semantics |
| --- | --- | --- | --- |
| `executeLanding()` returns `{ kind: "requested" }` | landing attempt started, PR handle present | tracker accepted landing request | event kind `landing-requested`; issue outcome `awaiting-landing` |
| `executeLanding()` returns `{ kind: "blocked" }` | landing attempt started, PR handle present | normalized blocked reason and lifecycle kind | event kind `landing-blocked`; issue outcome matches blocked lifecycle kind |
| `executeLanding()` throws before returning | landing attempt started, error string captured; request dispatch not confirmed | no successful landing result exists | event kind `landing-failed`; issue outcome `attempt-failed` |
| landing branch starts without a PR handle | orchestrator throws locally before tracker dispatch | no landing result | event kind `landing-failed`; issue outcome `attempt-failed` |

## Observability Requirements

- top-level event kind must indicate whether landing was requested, blocked, or failed
- landing failure summaries must say the request failed before/while dispatching, not imply a request was sent
- report timeline titles and summaries must render the new event kind distinctly
- event-to-outcome inference must not map landing failures to `awaiting-landing`
- existing landing-requested consumers should continue to see only genuine request-dispatch cases

## Implementation Steps

1. Add `landing-failed` to the issue artifact event-kind union and update any parsing/ordering helpers that rely on the closed set.
2. Update `#createLandingObservation()` in `src/orchestrator/service.ts` so:
   - blocked results still emit `landing-blocked`
   - requested results still emit `landing-requested`
   - thrown exceptions emit `landing-failed` and set the issue outcome to `attempt-failed`
3. Update `src/observability/issue-report.ts` to:
   - render a distinct title/summary for `landing-failed`
   - keep timeline ordering coherent
   - infer `attempt-failed` from `landing-failed`
4. Add or update focused tests for:
   - landing observation creation around requested/blocked/failed outcomes
   - issue-report inference/rendering for `landing-failed`
   - a tracker/orchestrator failure path where landing transport throws
5. Run repo validation and keep this branch as the single PR surface for `#132`.

## Tests

- unit coverage for landing observation creation with:
  - requested landing
  - blocked landing
  - thrown landing exception
- observability/report regression coverage proving:
  - `landing-failed` renders distinct timeline copy
  - report inference returns `attempt-failed` instead of `awaiting-landing`
- integration or e2e coverage with a mocked tracker/GitHub failure during landing execution
- standard repo gates:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`

## Acceptance Scenarios

1. When landing dispatch succeeds, artifacts still record `landing-requested` and the issue remains `awaiting-landing`.
2. When landing is blocked by guard logic, artifacts still record `landing-blocked` and the issue outcome matches the normalized blocked lifecycle kind.
3. When landing execution throws before request dispatch completes, artifacts record `landing-failed` and the issue summary/outcome reflect a failed attempt rather than `awaiting-landing`.
4. The issue report timeline and markdown summary describe landing failures as execution failures, not attempted requests.
5. Artifact consumers querying `landing-requested` no longer include thrown landing exception cases.

## Exit Criteria

- landing exceptions never emit `landing-requested`
- issue artifact summaries and report inference distinguish requested, blocked, and failed landing paths
- regression coverage exists for the thrown-exception path
- local validation passes
- the resulting PR stays limited to the landing observability seam for `#132`

## Deferred

- guarded-landing policy changes
- broader artifact-schema redesign beyond this one event-kind addition
- retry/reconciliation behavior changes for landing failures
- tracker transport hardening unrelated to the observability contract

## Decision Notes

- Introduce a dedicated `landing-failed` event kind rather than overloading `landing-requested` with `success: false`. The top-level kind is the durable contract consumed by reports and metrics, so the semantic distinction belongs there.
- Keep the failure mapped to `attempt-failed` rather than inventing a new issue outcome in this issue. That preserves the narrow seam while still separating failed execution from a successful landing request.
