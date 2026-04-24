# Issue 358 Plan: Block Landing On Current-Head Devin Review Findings

## Status

- implementation complete locally
- plan approval waived by operator instruction: "fix it in symphony yes"

## Goal

Prevent GitHub PRs from reaching `awaiting-landing-command` or passing guarded landing when a current-head Devin review summary explicitly reports unresolved findings, including the newer wording `found 1 new potential issue`.

## Scope

- tighten Devin verdict parsing for current review/comment summary bodies
- make the legacy approved-review-bot compatibility path treat current-head PR review findings as actionable blockers
- add unit and integration regression tests for the PR-review-summary shape that caused Alexandria PR 39 to look landable
- tighten operator guidance so `/land` is not posted solely because the status surface reports `awaiting-landing-command`

## Non-Goals

- redesign reviewer-app configuration
- add native adapters for other reviewer apps
- change GitHub transport queries beyond the existing review/comment/check surfaces
- change runner, workspace, or orchestrator retry behavior

## Current Gaps

- The native Devin adapter only recognizes `found <n> potential issues`; it misses singular `issue` and `new potential issue(s)`.
- The legacy approved-review-bot path counts current-head PR reviews as required reviewer coverage, but does not inspect their bodies for findings.
- Operator instructions need an explicit reminder that `/land` requires clean current-head reviewer-app summary evidence, not only a clean lifecycle label.

## Spec Alignment By Abstraction Level

- Policy: PR lifecycle must not classify current-head reviewer-app findings as landable.
- Configuration: no config shape changes; existing `reviewer_apps`, `review_bot_logins`, and `approved_review_bot_logins` contracts remain valid.
- Coordination: orchestration consumes the corrected normalized lifecycle only; no orchestrator changes are needed.
- Execution: no runner or workspace changes.
- Integration: GitHub tracker normalization owns raw review-body parsing and legacy compatibility.
- Observability: existing reviewer verdict and actionable-feedback surfaces should now explain the blocker; operator prompt gets a guardrail for status mismatches.

## Architecture Boundaries

- Devin-specific string parsing belongs in reviewer-app normalization helpers.
- Legacy compatibility may call reviewer-app verdict helpers for known approved bot logins, but generic PR policy must stay app-agnostic.
- Operator instructions may require an independent review-summary check before `/land`, but they must not become the only correctness mechanism.

## Implementation Steps

1. Extract or expose a reusable Devin verdict parser that recognizes current Devin pass and findings wording.
2. Use that parser in both the native Devin adapter and the legacy approved-review-bot adapter.
3. In legacy compatibility, convert current-head PR reviews with recognized issues-found verdicts into `pull-request-review` actionable feedback.
4. Preserve clean current-head PR reviews as required-reviewer coverage.
5. Add regression tests for native reviewer-app and legacy approved-review-bot configurations.
6. Update the operator prompt to state that `awaiting-landing-command` is not sufficient if top-level current-head bot review summaries still report findings.

## Tests

- Unit: `createPullRequestSnapshot()` classifies `**Devin Review** found 1 new potential issue.` as `issues-found` for native Devin reviewer apps.
- Unit: legacy `approvedReviewBotLogins: ["devin-ai-integration"]` treats the same current-head PR review body as actionable `pull-request-review` feedback.
- Integration: `GitHubTracker.inspectIssueHandoff()` reports `rework-required` for the legacy Alexandria-style config when Devin leaves that current-head PR review summary.

## Acceptance

- A current-head Devin PR review saying `found 1 new potential issue` blocks landing.
- Legacy Alexandria-style reviewer-bot config no longer treats that review as a clean required-reviewer pass.
- Guarded landing remains blocked because the normalized pull-request snapshot contains actionable bot feedback.
- Operator guidance no longer encourages `/land` from status alone when bot summary evidence contradicts it.

## Verification

- `pnpm exec vitest run tests/unit/pull-request-snapshot.test.ts tests/integration/github-bootstrap.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
