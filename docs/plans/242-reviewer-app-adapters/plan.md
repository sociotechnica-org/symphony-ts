# Issue 242 Plan: Add Pluggable Reviewer-App Adapters With Normalized Coverage And Verdicts

## Status

- approved

## Goal

Introduce a pluggable GitHub reviewer-app adapter seam so Symphony evaluates reviewer coverage, run status, verdict, and unresolved reviewer feedback from normalized per-app snapshots instead of inferring landing readiness from mixed raw PR surfaces.

## Scope

- add a typed GitHub `reviewer_apps` workflow contract with explicit `accepted` and `required` policy flags
- add a normalized reviewer-app snapshot contract at the tracker integration edge
- add a GitHub reviewer-app registry with one real `devin` adapter and one legacy compatibility adapter for the current bot-login behavior
- migrate PR lifecycle and guarded landing policy to normalized reviewer-app snapshots
- update tests and docs for missing, running, pass, issues-found, stale-head, and unknown-verdict reviewer outcomes

## Non-goals

- implementing every existing reviewer bot as a first-class adapter in this slice
- redesigning the overall landing topology, human `/land` protocol, or review-loop retry policy
- changing Linear or non-GitHub tracker behavior
- adding reviewer-app retriggering, timer-based escalation, or remote reviewer orchestration
- building a broad operator dashboard redesign beyond the normalized facts needed for this issue

## Current Gaps

- `src/tracker/pull-request-snapshot.ts` still mixes top-level comments, reviews, review threads, and status checks into a small set of booleans and feedback lists
- reviewer-app-specific parsing rules such as Devin verdict strings do not live behind a stable integration seam
- current policy can count reviewer coverage without an explicit pass verdict, and can miss explicit issues-found output when it is not represented as unresolved threads or classified comments
- legacy config fields `review_bot_logins` and `approved_review_bot_logins` overload several policy concepts and cannot express accepted-vs-required reviewer semantics cleanly
- reviewer-app behavior is hard to test deterministically because coverage, verdict, and unresolved feedback are not modeled separately

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: require explicit pass verdicts from required reviewer apps before landing, and treat issues-found verdicts as actionable rework
  - does not belong: Devin-specific strings, GitHub GraphQL field mapping, or check-status transport details
- Configuration Layer
  - belongs: typed `tracker.reviewer_apps` parsing plus compatibility with the legacy bot-login fields
  - does not belong: reviewer verdict parsing or lifecycle transitions
- Coordination Layer
  - belongs: consume normalized lifecycle outcomes such as waiting, rework-required, degraded reviewer infrastructure, and awaiting landing
  - does not belong: app-specific review parsing or raw GitHub review/comment inspection
- Execution Layer
  - belongs: no workspace or runner changes in this slice
  - does not belong: reviewer-app normalization or landing policy
- Integration Layer
  - belongs: reviewer-app adapter registry, per-app coverage/status/verdict parsing, and compatibility normalization for legacy bot-login behavior
  - does not belong: orchestrator retry budgeting or operator rendering policy
- Observability Layer
  - belongs: summaries and artifacts that reflect normalized reviewer-app gating reasons
  - does not belong: reverse-engineering reviewer-app state from raw GitHub payloads outside the tracker

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts` and `src/config/workflow.ts`
  - add the typed `tracker.reviewer_apps` config seam and preserve backward compatibility with existing bot-login fields
- `src/tracker/`
  - add reviewer-app snapshot types plus a registry that keeps app-specific parsing at the integration edge
  - add one real `devin` adapter for current-head coverage, running detection, verdict parsing, and actionable feedback extraction
  - add a legacy compatibility adapter so existing review-bot and approved-review-bot behavior still works while the new seam lands
  - update PR lifecycle and guarded landing policy to consume normalized reviewer-app snapshots
- tests and docs
  - extend unit, integration, and e2e coverage plus workflow docs/examples for the new config and policy surface

### Does not belong in this issue

- tracker transport rewrites unrelated to reviewer-app surfaces
- broad refactors across orchestrator state, runner control, or workspace lifecycle
- Linear parity or multi-tracker reviewer-app abstractions
- a second configuration system for human review policy

## Layering Notes

- `config/workflow`
  - owns parsing and validation for reviewer-app policy declarations
  - must not parse reviewer verdict text
- `tracker`
  - owns GitHub review/check normalization and reviewer-app parsing
  - must keep transport, normalization, and policy in distinct modules
- `workspace`
  - unchanged
- `runner`
  - unchanged
- `orchestrator`
  - reacts only to normalized lifecycle and landing-blocked reasons
  - must not inspect reviewer-app logins, review text, or check names directly
- `observability`
  - renders the normalized lifecycle summaries
  - must not re-derive reviewer coverage or verdict from tracker payload side effects

## Slice Strategy And PR Seam

Keep this issue to one tracker-boundary PR:

1. add the reviewer-app config and normalized snapshot contract
2. land the adapter registry with `devin` plus a legacy compatibility adapter
3. migrate lifecycle/landing policy and regression coverage to the normalized seam

Deferred:

- additional first-class reviewer-app adapters beyond Devin
- richer quorum rules such as one-of vs all-of reviewer requirements
- dedicated status/TUI reviewer-app tables beyond the summaries already fed by tracker lifecycle results

This stays reviewable because it moves app-specific semantics to one integration seam without reopening runner, orchestration, or broader tracker transport design.

## Runtime State Model

### Per-app reviewer states

Each configured reviewer app produces a current-head snapshot with:

1. `coverage`
   - `missing`
   - `observed`
2. `status`
   - `running`
   - `completed`
   - `unknown`
3. `verdict`
   - `pass`
   - `issues-found`
   - `unknown`

Each snapshot also carries:

- `actionableFeedback`
- `unresolvedFeedbackIds`
- evidence pointers for debugging

### Aggregate required-reviewer gate states

1. `not-required`
   - no required reviewer apps are configured
2. `running`
   - at least one required reviewer app is still running on the current head
3. `missing`
   - required reviewer output is absent after the normal check surface has settled
4. `unknown`
   - required reviewer output was observed, but no explicit pass/fail verdict could be normalized
5. `satisfied`
   - every required reviewer app has current-head coverage and an explicit `pass` verdict

### Lifecycle transitions relevant to this issue

- `awaiting-system-checks` -> `rework-required`
  - an accepted reviewer app reports `issues-found` or emits actionable unresolved feedback
- `awaiting-system-checks` -> `degraded-review-infrastructure`
  - required reviewer coverage is missing after checks settle, or verdict remains unknown
- `awaiting-system-checks` -> `awaiting-landing-command`
  - checks are settled, all required reviewer apps explicitly pass, and no actionable feedback remains
- `awaiting-landing` -> `degraded-review-infrastructure`
  - guarded landing re-check sees missing or ambiguous required reviewer results on the current head
- `awaiting-landing` -> `handoff-ready`
  - merge succeeds after the normalized reviewer gate passes

## Failure-Class Matrix

| Observed condition                                                                 | Local facts available     | Normalized reviewer facts available                       | Expected decision                                                           |
| ---------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| Required reviewer check is pending on the current head                             | no landing attempt active | required reviewer state = `running`                       | stay in `awaiting-system-checks`                                            |
| Required reviewer never emitted current-head output after checks settled           | no landing attempt active | required reviewer state = `missing`                       | return `degraded-review-infrastructure`                                     |
| Required reviewer emitted current-head output but no explicit pass/fail was parsed | no landing attempt active | required reviewer state = `unknown`                       | return `degraded-review-infrastructure`                                     |
| Devin reports `No Issues Found` on the current head                                | no landing attempt active | Devin coverage observed, status completed, verdict `pass` | allow `awaiting-landing-command` when other gates pass                      |
| Devin reports `found N potential issues` on the current head                       | no landing attempt active | Devin verdict `issues-found`, actionable feedback present | return `rework-required`                                                    |
| Legacy bot comment/thread feedback exists on the current head                      | no landing attempt active | compatibility adapter actionable feedback present         | return `rework-required`                                                    |
| Prior-head reviewer output exists but Symphony pushed a new commit                 | no landing attempt active | current-head coverage missing or running for the new head | do not count stale reviewer evidence; keep waiting or degrade appropriately |
| `/land` exists but guarded landing re-check sees ambiguous required reviewer pass  | landing approval recorded | required reviewer state = `unknown`                       | block landing fail-closed                                                   |

## Storage / Persistence Contract

- no new durable store is introduced
- workflow config becomes the source of truth for explicit reviewer-app policy declarations
- reviewer-app snapshots remain normalized ephemeral tracker facts derived from the current PR head
- issue artifacts and landing-blocked events should preserve normalized reviewer gating summaries rather than raw GitHub review payloads

## Observability Requirements

- lifecycle summaries must distinguish:
  - reviewer still running
  - required reviewer missing
  - required reviewer verdict unknown
  - reviewer issues-found / actionable feedback
  - explicit pass with landing now awaiting `/land`
- the normalized reviewer-app seam must be testable directly in unit coverage
- docs/examples should show the preferred `tracker.reviewer_apps` configuration

## Decision Notes

- Keep a legacy compatibility adapter in this slice so the new seam lands without forcing a one-shot migration for every bot-specific rule.
- Treat required reviewer verdict `unknown` as fail-closed degraded infrastructure. Coverage alone is not sufficient for deterministic landing under this issue.
- Keep app-specific parsing in dedicated adapter modules. `pull-request-policy.ts` and `guarded-landing.ts` should never inspect Devin strings directly.

## Implementation Steps

1. Restore the checked-in issue plan path referenced by the approved issue handoff.
2. Add the typed `tracker.reviewer_apps` workflow contract and validation for supported GitHub reviewer-app keys.
3. Add normalized reviewer-app snapshot types plus a GitHub reviewer-app registry seam.
4. Implement the `devin` adapter for:
   - current-head coverage detection
   - running detection from the current-head check surface
   - explicit pass / issues-found verdict parsing
   - actionable feedback extraction from top-level review artifacts
5. Implement a legacy compatibility adapter that preserves the current bot-login behavior for existing `review_bot_logins` / `approved_review_bot_logins` workflows.
6. Update `createPullRequestSnapshot()` to aggregate normalized reviewer-app snapshots into lifecycle inputs without mixing app-specific parsing into policy.
7. Update PR lifecycle and guarded landing policy to require explicit pass verdicts for required reviewer apps and to fail closed on missing or ambiguous required reviewer results.
8. Update docs/examples and add regression coverage across workflow parsing, unit, integration, and e2e layers.
9. Run local self-review and repository gates before opening/updating the PR:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `codex review --base origin/main` if available and reliable

## Tests And Acceptance Scenarios

### Unit

- workflow parsing accepts `tracker.reviewer_apps.devin` and rejects invalid reviewer-app configs
- reviewer snapshot normalization marks Devin current-head `pass`, `issues-found`, `running`, `missing`, and `unknown` cases correctly
- stale prior-head reviewer evidence does not satisfy current-head coverage
- lifecycle policy returns degraded infrastructure when required reviewer coverage is missing or verdict is unknown
- guarded landing blocks when required reviewer verdict is missing or unknown

### Integration

- `GitHubTracker.inspectIssueHandoff()` treats current-head Devin `No Issues Found` as landing-eligible when other gates are green
- `GitHubTracker.inspectIssueHandoff()` treats current-head Devin `found N potential issues` as `rework-required`
- `GitHubTracker.inspectIssueHandoff()` stays non-landable while a required Devin check is still pending
- `GitHubTracker.executeLanding()` fails closed when required reviewer coverage is missing or verdict remains unknown

### End-to-end

- factory run opens a PR, CI turns green, required reviewer output is missing, and the run remains visibly degraded instead of landable
- factory run opens a PR, required Devin output reports issues on the current head, and the run enters rework instead of awaiting `/land`
- after a follow-up push, stale prior-head reviewer output no longer satisfies the new head

## Exit Criteria

1. reviewer-app parsing lives behind a pluggable tracker-edge seam
2. Devin is implemented through that seam
3. landing requires explicit pass verdicts from required reviewer apps
4. a PR cannot become landable when Devin explicitly reports issues on the current head
5. legacy bot-login behavior still works through a compatibility adapter
6. docs and tests reflect the new `tracker.reviewer_apps` contract
7. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass

## Deferred To Later Issues Or PRs

- additional first-class reviewer-app adapters such as Greptile or Cursor-specific verdict parsers
- richer reviewer quorum policy and per-app retry/retrigger semantics
- tracker-agnostic reviewer-app abstractions for Linear or future backends
- dedicated reviewer-app tables in TUI/status surfaces beyond the lifecycle summaries in this slice
