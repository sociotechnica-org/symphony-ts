# Issue 48 Plan: Plan Review Comment Protocol And Acknowledgement Loop

## Objective

Make the GitHub-based human plan review station explicit and machine-readable by standardizing the `plan-ready` comment format, the accepted human review reply markers, and the acknowledgement comment the tracker posts after it reads a review decision.

## Scope

- standardize the `plan-ready` issue comment format in checked-in workflow/policy docs
- include copy-pasteable fenced markdown reply templates for `approved`, `changes-requested`, and `waived`
- add tracker-edge acknowledgement comments after the latest explicit review decision is read
- ensure acknowledgement comments are posted once per review comment, not once per poll
- add tests for the accepted review markers, acknowledgement emission, and repo-policy wording

## Non-goals

- changing the runtime waiting-state semantics from `#42`
- redesigning PR review handling
- Beads-native plan review UX
- generalizing lifecycle semantics beyond the GitHub bootstrap tracker
- cross-repo publication or reporting work

## Current Gap

The repo policy and prompts now describe a human plan review station, but the protocol is underspecified and only partially visible to humans:

- `plan-ready` comments do not provide a rigid reply template for humans
- the tracker reads explicit plan review markers, but the issue thread does not acknowledge what decision was read or what action will happen next
- this makes the issue thread harder to interpret and leaves the protocol too implicit for future Beads migration

## Spec / Layer Mapping

- Policy: accepted plan review states and comment protocol
- Configuration: none beyond existing tracker/workflow configuration
- Coordination: unchanged; runtime semantics already fixed in `#42`
- Execution: none
- Integration: GitHub issue comment read/write behavior in the bootstrap tracker
- Observability: acknowledgement comments provide human-visible handoff traceability

## Architecture Boundaries

### Belongs in this issue

- tracker-edge parsing/formatting for plan review comments
- repo-owned workflow/policy text that instructs workers how to emit the `plan-ready` handoff comment
- tests for protocol acceptance and single-emission acknowledgement behavior

### Does not belong in this issue

- orchestrator lifecycle redesign
- tracker-neutral handoff generalization (`#50`)
- Beads workflow migration
- dashboards or richer worker visibility
- report generation and publication

## Slice Strategy

This should fit in one reviewable PR because it is one narrow seam:

1. tighten the repo-owned prompt/policy text for `plan-ready`
2. add a small tracker-edge acknowledgement mechanism
3. add focused tests around those behaviors

The slice stays reviewable by keeping all changes in workflow docs, the plan review parser, the GitHub tracker adapter, and related tests.

## Runtime State / Failure Notes

`#42` already established `awaiting-plan-review` as a valid handoff state. This issue should not change the state machine. The only runtime-sensitive behavior is preventing repeated acknowledgement comments during polling by keying acknowledgements to the latest parsed human review comment.

## Implementation Steps

1. Add a small plan-review protocol helper that:
   - parses the latest explicit plan review signal from issue comments
   - parses prior acknowledgement comments
   - formats the acknowledgement body for each accepted review decision
2. Update the GitHub bootstrap tracker so that when it reads `changes-requested`, `approved`, or `waived` as the latest explicit review decision with no PR yet, it posts one acknowledgement comment if that exact review comment has not already been acknowledged.
3. Keep the acknowledgement behavior at the tracker edge rather than the orchestrator.
4. Update `WORKFLOW.md`, `AGENTS.md`, and `skills/symphony-plan/SKILL.md` so the `plan-ready` comment includes:
   - plan path
   - summary
   - brief instructions
   - fenced markdown reply templates
5. Extend tests:
   - unit tests for plan review parsing / acknowledgement recognition
   - integration tests that the tracker posts acknowledgement comments once per review comment
   - planning contract tests for the template wording in workflow/policy docs

## Tests And Acceptance Scenarios

- unit: parse `Plan review: approved`, `changes-requested`, `waived`
- unit: detect an acknowledgement comment for a specific source review comment id
- integration: latest `changes-requested` produces one acknowledgement comment and does not duplicate on unchanged polls
- integration: latest `approved` produces one acknowledgement comment and does not duplicate on unchanged polls
- integration: latest `waived` produces one acknowledgement comment and does not duplicate on unchanged polls
- contract: workflow/policy docs include copy-pasteable reply templates and explicit accepted markers
- repo gate: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `codex review --base origin/main`

## Observability

The issue thread itself is the human-visible observability surface for this slice. Each parsed human review decision should have an acknowledgement comment that states the next action.

## Exit Criteria

- `plan-ready` workflow text is standardized across repo-owned docs
- explicit human reply templates are present in the runtime contract
- the GitHub tracker posts one acknowledgement comment per explicit review decision
- acknowledgement comments are not duplicated on repeated unchanged polls
- tests cover both the protocol parsing and acknowledgement emission

## Deferred Work

- tracker-neutral handoff lifecycle generalization (`#50`)
- Beads-native review state and conversation UX
- stronger author validation for review comments if the token/identity model changes

## Revision Log

- 2026-03-07: Initial plan written. Human plan review explicitly waived by operator instruction in chat so implementation may proceed directly from this plan.
