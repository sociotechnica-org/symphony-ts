# Issue 307 Plan

- Status: waived
- Issue: #307
- Branch: `symphony/307`
- Plan path: `docs/plans/307-restore-issue-transition-reporting/plan.md`

## Scope

Restore the missing per-issue transition-history reporting path after #290 merged incompletely, while tightening a few low-risk correctness edges called out in review.

## Non-goals

- Redefine overall GitHub activity completeness semantics beyond the transition-specific fields.
- Rework campaign/token pricing behavior unrelated to transition history.
- Broaden the artifact contract beyond tracker state, tracker labels, and derived transitions.

## Layer Mapping

- Observability: restore issue-report transition rendering and campaign compatibility.
- Coordination: keep terminal failure artifact capture aligned with tracker-side label changes and warn when degraded.
- Integration: preserve tracker-side snapshots as the source for transition derivation; do not add tracker-specific policy here.
- Not in scope: configuration, execution, runner transport, or tracker transport changes.

## Current Gaps

- `buildGitHubActivity` in `src/observability/issue-report.ts` still reports transition history as unavailable on `main`.
- Legacy summaries can emit a synthetic null-to-open baseline transition when the first tracker snapshot is written after upgrade.
- Tracker label-set equality depends on pre-normalized arrays without documenting or enforcing the invariant.
- The post-failure tracker refresh falls back silently when `getIssue` fails, making degraded transition capture invisible.

## Implementation Steps

1. Restore per-issue transition-history derivation in `src/observability/issue-report.ts` without disturbing the newer token/pricing logic from #289.
2. Update `src/observability/issue-artifacts.ts` so legacy summaries establish a baseline without recording synthetic transitions, and make label-set comparison robust to unsorted inputs.
3. Add a warning in `src/orchestrator/service.ts` when post-failure tracker refresh fails and the terminal artifact must fall back to the pre-failure snapshot.
4. Keep campaign/markdown surfaces aligned with the restored issue-report shape and clean up any small transition-status accounting nits that stay in-scope.
5. Update focused unit tests for artifact transition derivation, issue reports, campaign aggregation, and orchestrator failure capture.

## Tests

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- targeted assertions in:
  - `tests/unit/issue-artifacts.test.ts`
  - `tests/unit/issue-report.test.ts`
  - `tests/unit/campaign-report.test.ts`
  - `tests/unit/orchestrator.test.ts`

## Acceptance

- Issue reports surface observed issue transitions when canonical artifacts contain tracker snapshots/transitions.
- Legacy artifact upgrades do not report a misleading null-to-open baseline transition.
- Label transition derivation remains deterministic even if inputs are not pre-normalized.
- Terminal failure capture warns when tracker refresh fails and transitions may be absent.
- Full repo validation passes.
