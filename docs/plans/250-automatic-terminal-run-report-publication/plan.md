# Issue 250 Plan: Automatic Terminal-Run Report Publication

## Status

`plan-ready`

## Goal

Make per-issue report generation a standard post-terminal step for successful and failed issue runs, and add an optional workflow-owned archive-publication path so a configured `factory-runs` checkout is updated automatically without requiring manual `symphony-report` follow-up commands.

## Scope

This slice covers:

1. automatic per-issue report generation after terminal success/failure
2. an explicit workflow/config contract for optional automatic `factory-runs` publication
3. a small, typed post-terminal reporting state/receipt contract that records generation and publication outcomes per issue
4. coordinator-owned triggering plus restart-time reconciliation for terminal issues whose reporting work is missing or blocked
5. operator/status surfacing so missing archive config, successful publication, partial publication, and blocked publication are inspectable
6. focused unit, integration, and end-to-end coverage for successful and failed runs plus restart recovery of blocked publication work
7. docs updates for the new runtime behavior and workflow config

## Non-goals

This slice does not include:

1. making archive publication mandatory for all workflows
2. pushing, committing, or opening PRs in the `factory-runs` repository
3. campaign-level archive automation or digest publication
4. redesigning the existing issue-report schema beyond the additive state/receipt metadata needed for automation
5. moving tracker, runner, or workspace policy into the report/publication services
6. turning operator review state into the canonical source of terminal reporting truth

## Current Gaps

Today the repo has the required detached building blocks but no normal runtime automation:

1. `writeIssueReport()` exists, but the orchestrator does not invoke it automatically when an issue becomes terminal
2. `publishIssueToFactoryRuns()` exists, but publication only happens through the detached CLI
3. there is no workflow-owned config for a default archive root
4. there is no durable per-issue reporting receipt that tells operators whether automatic generation/publication ran, was skipped, or failed
5. restart recovery does not reconcile terminal issues that are missing reports or blocked on publication
6. the operator/report surfaces can discover completed reports later, but they do not show whether the standard terminal automation succeeded

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that report generation is a standard terminal step for both success and failure
2. the rule that archive publication is optional and enabled only when configured
3. the rule that missing archive configuration is explicit and inspectable rather than silently treated as success
4. the rule that terminal issue completion remains tracker truth even if reporting/publication is blocked

Does not belong here:

1. raw file-copy mechanics
2. tracker transport details
3. hidden operator-only conventions for whether publication ran

### Configuration Layer

Belongs here:

1. a typed `WORKFLOW.md` contract for optional automatic archive publication
2. path resolution for the configured archive root relative to the owning workflow/instance root
3. parser validation and docs for the new observability/reporting config surface

Does not belong here:

1. inline publication logic
2. status rendering rules
3. coordinator retry state encoded only in prompt text

### Coordination Layer

Belongs here:

1. triggering post-terminal reporting work from the terminal success/failure seam
2. explicit runtime-state transitions for whether a terminal issue still needs report generation/publication work
3. restart-time reconciliation of missing or blocked reporting work for already-terminal issues
4. keeping reporting failures observable without reopening tracker lifecycle policy

Does not belong here:

1. tracker-specific archive behavior
2. report rendering details
3. file-copy code for `factory-runs`

### Execution Layer

Belongs here:

1. no new runner/workspace responsibilities beyond existing raw artifacts consumed by report generation

Does not belong here:

1. archive publication policy
2. post-terminal report state ownership
3. ad hoc workspace retention changes created only for publication

### Integration Layer

Belongs here:

1. optional `factory-runs` publication using the configured archive root
2. normalization of publication outcomes into a stable receipt/status shape for the coordinator
3. idempotent publish behavior when restart reconciliation re-runs a terminal publication

Does not belong here:

1. orchestrator dispatch or retry policy
2. issue-report derivation logic
3. operator review-state bookkeeping

### Observability Layer

Belongs here:

1. automatic report generation over canonical issue artifacts
2. the durable per-issue reporting receipt/state contract
3. status-facing summaries of report/publication state
4. read/write helpers for the receipt contract and any additive artifact pointers

Does not belong here:

1. tracker mutations
2. archive git operations beyond local publication results
3. retry/backoff logic that belongs to the coordinator

## Architecture Boundaries

### `src/orchestrator/`

Owns:

1. detecting terminal issue transitions and invoking post-terminal reporting automation
2. explicit transition logic for pending/generated/published/blocked reporting work
3. restart reconciliation for terminal reporting receipts

Does not own:

1. report composition internals
2. archive directory layout policy
3. operator review-ledger state

### `src/observability/`

Owns:

1. `writeIssueReport()` reuse for automatic generation
2. a typed reporting receipt/state document stored with instance-owned issue artifacts
3. status-friendly summaries for the latest generation/publication outcome

Does not own:

1. tracker completion/failure transitions
2. archive-root config parsing
3. `factory-runs` worktree validation logic

### `src/integration/`

Owns:

1. `factory-runs` publication and normalized publication result details
2. resolving publication status as `published`, `partial`, or blocked with factual notes

Does not own:

1. whether publication should run
2. report-generation fallback policy
3. coordinator restart decisions

### `src/config/` and docs

Own:

1. the new optional workflow field for archive publication
2. parser validation and path resolution
3. README/frontmatter docs updates

Do not own:

1. publication state mutations
2. report rendering
3. operator runtime decisions

## Slice Strategy And PR Seam

This issue fits in one reviewable PR by staying on one post-terminal reporting seam:

1. add a narrow workflow/config contract for optional publication
2. add a focused terminal-reporting receipt/service seam in observability/integration
3. wire the coordinator to trigger and reconcile that seam after terminal issue transitions
4. update status/operator docs and tests around that one runtime behavior

This PR deliberately defers:

1. campaign/archive automation beyond the per-issue terminal path
2. remote git publication from the archive checkout
3. broader operator-loop redesign or follow-up issue filing changes
4. any redesign of the canonical report schema beyond what the receipt/status seam strictly needs

Why this seam is reviewable:

1. it preserves the existing report-generation and `factory-runs` publication services as the core workhorses
2. it keeps tracker policy, report rendering, and archive file-copy code in their existing layers
3. it limits coordination changes to one explicit terminal follow-through path instead of broad run-loop refactors

## Runtime State Model

This issue changes post-terminal orchestration behavior, so the reporting follow-through state must be explicit rather than inferred from ad hoc file existence checks.

### Reporting subject

One reporting subject is a terminal issue keyed by:

1. issue number
2. terminal issue update timestamp / observed terminal transition
3. current report generation timestamp when present
4. configured archive root identity when publication is enabled

### Receipt states

1. `pending-generation`
   - the issue is terminal, but the current terminal report has not been generated yet
2. `report-generated`
   - the current terminal report exists and publication is not configured
3. `pending-publication`
   - the current terminal report exists and archive publication is configured but not yet completed for the current receipt
4. `published`
   - the current terminal report was generated and publication completed
5. `publication-partial`
   - required report files were published, but some log-copy outcomes were partial
6. `blocked`
   - report generation or publication failed for the current terminal receipt and needs reconciliation

### Allowed transitions

1. `pending-generation -> report-generated`
2. `pending-generation -> pending-publication`
3. `pending-generation -> blocked`
4. `report-generated -> pending-publication`
   - only if config changes to enable publication and the existing report remains current
5. `pending-publication -> published`
6. `pending-publication -> publication-partial`
7. `pending-publication -> blocked`
8. `publication-partial -> published`
   - on a later successful republish
9. `publication-partial -> blocked`
10. `blocked -> pending-generation`
    - when the blocker was report generation and the coordinator retries on restart/poll
11. `blocked -> pending-publication`
    - when the report exists and only publication needs another attempt
12. any terminal receipt state -> `pending-generation`
    - when the issue reaches a newer terminal update that makes the stored report stale

### Coordinator rules

1. tracker completion/failure remains the terminal source of truth even when the receipt is `blocked`
2. the coordinator should run reporting work after terminal artifact persistence so report generation reads the current canonical facts
3. restart reconciliation should examine terminal issues plus the receipt document and resume only the missing blocked step for the current terminal receipt
4. reporting follow-through must not consume the issue retry budget used for coding-agent failures

## Failure-Class Matrix

| Observed condition                                                             | Local facts available                                     | Normalized tracker facts available | Expected decision                                                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Issue reaches terminal success/failure, no receipt exists yet                  | current terminal issue artifacts and session/log pointers | issue is already terminal          | create `pending-generation`, generate report immediately, then continue to publish or finalize |
| Terminal issue has current report and no archive root configured               | current report exists, no publish config                  | issue is terminal                  | mark/report `report-generated` with explicit “publication not configured” note                 |
| Terminal issue has current report and configured archive root                  | current report exists, publish config resolves            | issue is terminal                  | move to `pending-publication` and publish immediately                                          |
| Report generation fails (artifact parse error, write failure, stale invariant) | terminal artifacts plus error                             | issue is terminal                  | record `blocked` at generation stage; keep issue terminal and surface blocker                  |
| Publication fails because archive root is missing/unwritable                   | current report exists plus publish error                  | issue is terminal                  | record `blocked` at publication stage with explicit archive-root error                         |
| Publication succeeds with referenced/unavailable logs only                     | current report plus partial publish metadata              | issue is terminal                  | record `publication-partial`; do not treat as blocked if required files landed                 |
| Factory restarts and finds terminal issue with stale/missing receipt           | terminal issue artifacts and maybe stale receipt          | issue is terminal                  | reconcile: rerun only the missing step for the current terminal receipt                        |
| Factory restarts and finds already-published current receipt                   | current report receipt and publish metadata               | issue is terminal                  | do nothing; keep published/partial status visible                                              |

## Storage And Persistence Contract

This slice adds a durable per-issue reporting receipt under the instance-owned artifact tree. The exact filename can be chosen during implementation, but the contract should live with the issue artifacts, not in operator-only state.

Contract rules:

1. the receipt is additive to existing canonical issue artifacts and generated reports
2. it records the current terminal issue identity, report generation facts, publication facts, stage-specific notes, and timestamps
3. it distinguishes `not configured`, `blocked`, `partial`, and `published` explicitly instead of overloading one summary string
4. it points back to canonical generated report paths and published archive paths when available
5. it is rewritten atomically so restart reconciliation never reads truncated state

## Observability Requirements

1. terminal issue status/output should expose whether the current report is pending, generated only, published, partial, or blocked
2. missing archive configuration must be visible as an explicit state/note rather than indistinguishable from successful publication
3. blocked reporting/publication must include the stage and a factual error summary
4. operator-facing docs must describe where to inspect the receipt and published outputs
5. generated report/publication automation should remain attributable to the current terminal issue state and not depend on operator scratchpads

## Implementation Steps

1. Add a typed workflow/config contract for optional archive publication under `observability`, including parser validation and path resolution relative to the instance root/workflow owner.
2. Add a small observability-side reporting receipt/state module that can read/write the per-issue terminal-reporting state atomically.
3. Extract or wrap the existing report-generation/publication calls behind a focused service that:
   - generates the current report
   - optionally publishes it
   - returns a normalized receipt update with stage, notes, and output paths
4. Wire the coordinator terminal success/failure seam so the service runs after terminal artifact persistence in both `#completeIssue` and `#failIssue`.
5. Add restart/poll reconciliation for terminal issues whose reporting receipt is missing, stale, or blocked, keeping this logic separate from runner retry budgeting.
6. Extend status/operator-facing surfaces to project the current reporting/publication outcome for terminal issues.
7. Update README and workflow-frontmatter docs for the new automatic behavior and optional archive-publication config.
8. Add focused tests and then one realistic end-to-end run that proves reports are emitted automatically without manual CLI invocation.

## Tests And Acceptance Scenarios

### Unit

1. config parsing resolves the optional archive root and rejects malformed values
2. reporting receipt transitions are explicit for generated-only, published, partial, and blocked outcomes
3. restart reconciliation chooses the missing step correctly for stale or blocked receipts

### Integration

1. terminal success automatically generates `report.json` and `report.md` without invoking `symphony-report issue`
2. terminal failure does the same and preserves explicit failure/report status
3. configured archive publication writes into `factory-runs` automatically and records the published receipt
4. missing or unwritable archive roots produce a blocked publication receipt with a factual note
5. partial log publication records `publication-partial` rather than pretending the issue was fully published

### End-to-end

1. a representative successful factory run ends with generated per-issue reports present under `.var/reports/issues/<issue-number>/`
2. the same run publishes into a configured local `factory-runs` checkout without manual report CLI commands
3. a representative failed run also emits the report automatically and leaves an inspectable receipt/state
4. a restarted runtime resumes a previously blocked publication path and converges once the archive root becomes valid

## Acceptance Scenarios

1. Given a successful issue run with no archive root configured, when the issue becomes terminal, then Symphony writes the per-issue report automatically and surfaces that publication was skipped because it was not configured.
2. Given a failed issue run with an archive root configured, when the issue becomes terminal, then Symphony writes the per-issue report automatically and publishes it into `factory-runs`.
3. Given a terminal issue whose archive publication failed, when the factory restarts after the archive root is repaired, then Symphony retries the missing publication step and records the converged success/partial result.
4. Given a terminal issue whose report generation fails, when an operator inspects status/artifacts, then the blocked stage and factual error are visible without reopening tracker lifecycle state.

## Exit Criteria

1. terminal success and exhausted terminal failure both trigger automatic per-issue report generation
2. archive publication is automatic only when configured through the workflow contract
3. operators can inspect whether the current terminal issue report is generated, published, partial, or blocked
4. restart reconciliation converges missing/blocked terminal reporting work without piggybacking on agent retry counters
5. docs and parser-aligned config references describe the new behavior accurately
6. relevant unit, integration, and end-to-end tests pass

## Deferred To Later Issues Or PRs

1. automatic campaign digest publication
2. archive-repo commit/push/PR automation
3. broader operator-loop behavior changes beyond consuming the surfaced receipt/status
4. any archive backlog backfill command for historical runs predating this receipt contract

## Decision Notes

1. Keep automatic report generation/publication as a coordinator-triggered follow-through path, not a pure operator-loop concern, because the issue goal is standard terminal behavior and should not depend on whether the operator wakes up.
2. Keep the receipt contract under instance-owned issue artifacts rather than `.ralph/` so terminal reporting truth remains part of runtime evidence, while operator review state remains a separate consumer.
3. Treat publication as optional config but generation as mandatory terminal follow-through so the repo always preserves local evidence even when no archive checkout exists.
