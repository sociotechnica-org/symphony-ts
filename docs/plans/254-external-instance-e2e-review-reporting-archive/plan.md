# Issue 254 Plan: Extend External-Instance End-to-End Coverage For Review, Reporting, And Archive Publication

## Status

- plan-ready

## Goal

Add end-to-end coverage that exercises a real external workflow root through the third-party factory path: issue pickup, runner execution, PR/review follow-up, terminal report generation, and archive publication. The main outcome is earlier CI detection for regressions that only show up when Symphony runs against a non-self-hosted instance.

## Scope

- add at least one end-to-end scenario that uses an external workflow root instead of the repo-under-test checkout as the instance root
- exercise a third-party runner path that reflects the external-instance failures called out in the issue summary, including runner accounting/reporting facts
- carry one issue through PR open, actionable review follow-up, terminal report generation, and automatic archive publication
- assert archive publication and generated report contents from the external instance root, not only tracker/PR status
- add or refine test helpers only where they make the external-instance seam explicit and keep the scenario reviewable
- update docs only if the test harness contract or operator expectations for external-instance coverage need to be explicit

## Non-goals

- redesigning tracker lifecycle policy, review-loop policy, or terminal reporting behavior
- adding new runner transports, reviewer-app adapters, or archive-publication features
- broad refactors across orchestrator, tracker, runner, and observability code just to support the test
- replacing existing self-hosted end-to-end coverage
- introducing live external network dependencies into CI

## Current Gaps

- `tests/e2e/bootstrap-factory.test.ts` already covers self-hosted review loops, Claude accounting, and automatic archive publication, but those assertions currently live in separate scenarios rooted in the same local temp instance
- the existing external-instance coverage is too shallow: it proves startup/path derivation seams, but it does not prove the full third-party handoff loop through review, reporting, and archive publication
- `tests/integration/factory-runs-cli.test.ts` proves publication behavior in isolation, but it does not prove the orchestrator triggers that path correctly for an external workflow root
- the first real `context-library` run exposed bugs in reviewer verdict handling, third-party runner/reporting, and manual report publication that current CI coverage did not catch as one coherent external-instance flow

## Decision Notes

- Treat this as a harness issue first. The preferred slice is a realistic external-instance regression scenario plus small helper cleanup, not a speculative runtime rewrite.
- Keep the external-instance scenario centered on one user-visible loop so the review surface stays narrow: pick up work, open/update PR, absorb review feedback, finish terminal reporting, publish archive.
- Reuse the current mock GitHub server, fake runner fixtures, and archive-publication helpers where possible. If a helper is missing, add the smallest reusable helper instead of copying setup inline.
- Prefer one main end-to-end regression that combines the previously separate risk areas over several loosely related smoke tests.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

- the repo-owned requirement that external-instance CI must prove the real handoff loop, not only startup
- the rule that review, reporting, and archive publication are part of end-to-end correctness for this issue’s scenario

Does not belong here:

- fixture-specific path plumbing
- archive file-copy mechanics
- tracker transport parsing details

### Configuration Layer

Belongs here:

- external workflow-root setup in test fixtures
- workflow fields needed to exercise third-party runner, review-bot expectations, and archive publication from a non-self-hosted instance root

Does not belong here:

- orchestrator state transitions
- report rendering internals
- tracker-side review evaluation logic

### Coordination Layer

Belongs here:

- existing orchestrator behavior that the test must exercise: pickup, rework after actionable feedback, terminal follow-through, and reporting reconciliation
- any test-only helper seam needed to observe that coordination behavior from an external instance root

Does not belong here:

- tracker-specific raw payload setup
- archive publication implementation details

### Execution Layer

Belongs here:

- third-party runner fixture selection and workspace-root expectations for an external instance
- preserving provider/accounting facts in issue artifacts and reports for the exercised runner path

Does not belong here:

- tracker lifecycle decisions
- report publication policy

### Integration Layer

Belongs here:

- mock GitHub review/check interactions
- archive-publication integration via the existing `factory-runs` path
- any helper updates that keep transport, normalization, and policy concerns separated while testing the external-instance scenario

Does not belong here:

- orchestrator retry policy rewrites
- observability-only formatting concerns

### Observability Layer

Belongs here:

- assertions over generated issue reports, terminal-reporting receipts, and published archive artifacts for the external instance
- coverage that proves runner accounting/reporting facts survive the full external-instance flow

Does not belong here:

- tracker mutations
- new archive or report product features unrelated to the regression seam

## Architecture Boundaries

### `tests/e2e/`

Owns:

- the new external-instance end-to-end regression scenario
- scenario-level assertions for review follow-up, issue artifacts, generated reports, and published archive outputs

Does not own:

- production policy changes unless the test exposes a concrete product bug that must be fixed for the scenario to pass

### `tests/support/`

Owns:

- any extracted helper for creating an external workflow root, archive root, or reusable review/report fixture setup
- keeping repeated temp-root, git, and workflow setup small and explicit

Does not own:

- production runtime branching
- tracker normalization logic

### Production code

Expected ownership in this slice:

- reuse current `src/orchestrator/`, `src/observability/`, `src/integration/`, and runner/tracker code paths as the behavior under test
- only accept production edits if the new end-to-end coverage exposes a concrete external-instance bug that blocks the scenario

Does not belong in this issue unless the test proves it is required:

- broad runner/watchdog redesign
- new report schema work
- new tracker review-policy features

## Layering Notes

- `config/workflow`
  - may gain test-helper coverage for external workflow-root contracts
  - must not hide archive or review logic in ad hoc helper defaults
- `tracker`
  - stays behind the mock server + existing normalization/policy seams
  - must not absorb test-only external-instance path logic
- `workspace`
  - owns external instance workspace derivation during the scenario
  - must not learn test-only tracker behavior
- `runner`
  - provides the exercised third-party execution/accounting facts
  - must not take on report/publication policy
- `orchestrator`
  - remains the coordinator under test
  - should only change if the new scenario reveals a real external-instance correctness bug
- `observability`
  - remains the system of record for issue artifacts, reports, and publication receipts asserted by the test
  - must not gain tracker-specific shortcuts for the harness

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on the external-instance regression-harness seam:

1. add a focused external-instance e2e scenario that covers review follow-up, reporting, and archive publication together
2. extract only the helper code needed to make that scenario readable and reusable
3. fix any concrete product bug the scenario exposes, but only if it is directly required for the external-instance flow to pass

Deferred from this PR:

- additional external-instance scenarios for every runner/provider combination
- broad fixture framework redesign
- operator-loop follow-up automation changes
- new archive/report features beyond the current automatic terminal-publication contract

Why this seam is reviewable:

- it reuses existing production seams instead of mixing several new features into one patch
- it keeps tracker transport, normalization, and policy in their current layers
- it limits harness work to one realistic scenario instead of a wide matrix that would be hard to review

## Runtime State Model Exercised By This Coverage

This slice is primarily about coverage, but the scenario must explicitly exercise the existing stateful orchestration path for an external instance.

### Scenario lifecycle states

1. `ready`
   - issue is eligible in the tracker and no local attempt exists yet
2. `running-initial-attempt`
   - external instance claims the issue, runs the third-party runner, and opens the PR
3. `awaiting-system-checks-or-review`
   - PR exists and the orchestrator is waiting on checks and normalized review state
4. `rework-required`
   - actionable review feedback exists on the current PR head
5. `running-follow-up-attempt`
   - the orchestrator reruns on the same branch and resolves the actionable review state
6. `terminal-success`
   - PR is merged or otherwise reaches the existing terminal success seam
7. `report-generated`
   - the current terminal issue report exists for the external instance
8. `archive-published`
   - publication metadata and published artifacts exist for the current terminal report

### Required transitions

- `ready -> running-initial-attempt`
- `running-initial-attempt -> awaiting-system-checks-or-review`
- `awaiting-system-checks-or-review -> rework-required`
- `rework-required -> running-follow-up-attempt`
- `running-follow-up-attempt -> awaiting-system-checks-or-review`
- `awaiting-system-checks-or-review -> terminal-success`
- `terminal-success -> report-generated`
- `report-generated -> archive-published`

### Explicitly out of scope for this slice

- new runtime states
- retry-budget redesign
- lease/reconciliation redesign beyond whatever the existing scenario already exercises

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| External instance opens a PR but review feedback arrives on the current head | external workflow root, issue artifacts, branch/session data | actionable review feedback on current PR | rerun on the same branch and keep the issue open until feedback is addressed |
| External instance reruns after review follow-up and the PR becomes clean | updated branch commit, resolved review thread, current session/accounting facts | clean review/check state | continue through landing/terminal success without reopening a new branch |
| Terminal success occurs but no report is generated for the external instance | terminal issue artifact exists, no current report files | issue is terminal | treat as a failing regression; coverage should require automatic report generation |
| Report exists but archive publication does not land in the configured archive root | report files exist, missing publication metadata/artifacts | issue is terminal | treat as a failing regression; coverage should require automatic publication |
| Third-party runner path finishes but report/accounting fields are missing from the external-instance artifacts | session artifact and report files exist | issue/PR lifecycle succeeded | treat as a failing regression; coverage should assert provider/accounting visibility |
| External instance startup passes but paths still resolve to the self-hosted checkout instead of the external root | workflow path, workspace path, report path, archive path | tracker state may still look healthy | treat as a failing regression; coverage should assert instance-rooted paths directly |

## Storage / Persistence Contract

- the external-instance scenario should continue to use the canonical instance-local `.tmp/` and `.var/` trees under the external workflow root
- generated report files, terminal-reporting receipts, and archive publication metadata remain the durable evidence asserted by the test
- do not introduce a second system of record for the harness; prefer reading the same files operators and later report tooling read

## Observability Requirements

- the scenario must assert generated `report.json` and/or `report.md` from the external instance root
- the scenario must assert archive publication outputs and metadata for the external instance root
- the scenario must assert the runner/provider accounting facts that motivated this issue, not just that a report file exists
- if the scenario uses review follow-up, the resulting issue-artifact or status evidence should show the review loop actually occurred rather than only inferring it from final success

## Implementation Steps

1. Inspect the current bootstrap e2e helpers and identify the smallest helper change needed to create a clearly external workflow root with archive configuration and third-party runner settings.
2. Add a focused end-to-end test scenario that:
   - runs from an external workflow root
   - opens a PR
   - receives actionable review feedback
   - reruns and resolves that feedback
   - reaches terminal success
   - generates the terminal issue report automatically
   - publishes the report to the configured archive root
3. Assert issue-artifact, report, receipt, and archive metadata facts that prove the external-instance path, review loop, and reporting/publication path all ran.
4. If the scenario exposes a product bug, fix the smallest production seam required and keep the fix scoped to the failing external-instance behavior.
5. Update docs only if the new external-instance harness or operator expectation needs explicit repository guidance.

## Tests And Acceptance Scenarios

- End-to-end
  - add one external-instance bootstrap-factory scenario that combines review follow-up, third-party runner/reporting facts, and automatic archive publication
- Integration
  - add or adjust a narrow helper-focused test only if the new scenario requires a reusable external-instance setup seam that is difficult to validate indirectly
- Unit
  - only if a newly extracted helper or bug fix introduces pure logic worth isolating

### Acceptance scenarios

1. Symphony runs from an external workflow root, not the repo-under-test checkout, and stores workspaces/reports under that external instance root.
2. The external-instance scenario opens a PR, receives actionable review feedback, reruns on the same branch, and clears the review state.
3. After terminal success, the external instance automatically generates the current issue report without a manual `symphony-report` command.
4. The generated report and/or receipt includes the expected third-party runner accounting/provider facts for the exercised path.
5. The configured archive root receives the published report artifacts and metadata for that external-instance run.

## Exit Criteria

- CI has end-to-end coverage for one realistic external-instance path through review, reporting, and archive publication
- the scenario proves instance-rooted paths rather than only self-hosted repo paths
- any product bug uncovered by that scenario is fixed in the same PR or explicitly deferred before implementation continues
- local validation passes:
  - targeted e2e test(s) for the new scenario
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`

## Deferred To Later Issues Or PRs

- expanding the matrix across more third-party providers or multiple external-instance scenarios
- broader runner/watchdog hardening beyond bugs directly exposed by this coverage
- campaign-level or operator-loop changes that consume the resulting reports
- any archive-publication behavior beyond the existing per-issue automatic terminal-publication path
