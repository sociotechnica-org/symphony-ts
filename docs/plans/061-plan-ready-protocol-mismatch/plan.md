# Issue 61 Plan: Fix Plan-Ready Protocol Mismatch

## Status

`approved`

## Goal

Make the plan-review handoff robust by ensuring the worker and tracker parser agree on the canonical `plan-ready` marker and by accepting the currently emitted `Plan ready for review.` wording as a compatible input.

## Scope

1. update the tracker-side parser to recognize the legacy/emitted `Plan ready for review.` first line as `plan-ready`
2. normalize worker-facing protocol text so the canonical first line is `Plan status: plan-ready`
3. add unit and integration coverage for both accepted `plan-ready` forms
4. keep review decision markers unchanged

## Non-goals

1. changing `approved`, `changes-requested`, or `waived` markers
2. redesigning the full plan-review UX or branch-push flow
3. changing orchestrator retry/requeue semantics beyond making the handoff detectable

## Spec / Layer Mapping

- Policy: accepted `plan-ready` marker semantics
- Configuration: none
- Coordination: no new orchestrator state shape; only restore correct entry into existing `awaiting-plan-review`
- Execution: none
- Integration: tracker comment parsing at the edge
- Observability: tests only

## Architecture Boundaries

- Tracker policy owns normalization of equivalent comment markers into `plan-ready`.
- Worker-facing prompts/docs must emit the canonical marker consistently.
- Orchestrator should continue to consume normalized `awaiting-plan-review`, not raw comment strings.

## Implementation Steps

1. extend `parsePlanReviewComment` to accept both canonical and legacy `plan-ready` first lines
2. tighten prompt/docs text so plan-ready examples use `Plan status: plan-ready`
3. add unit tests for both recognized forms
4. add integration coverage that the legacy marker still yields `awaiting-plan-review`

## Tests And Acceptance

1. unit: both `Plan status: plan-ready` and `Plan ready for review.` parse as `plan-ready`
2. integration: issue comments with either marker yield `awaiting-plan-review`
3. local gate: format, lint, typecheck, test

## Exit Criteria

1. runtime no longer fails a valid plan-review handoff because of the legacy first line
2. worker-facing protocol text consistently uses the canonical marker
3. tests cover both forms

## Deferred

1. richer plan-review comment UX in `#48`
2. branch-push/direct-link recoverability in `#53`
