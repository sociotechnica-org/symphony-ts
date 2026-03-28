# Issue 242 Plan: Add Pluggable Reviewer-App Adapters With Normalized Coverage And Verdicts

## Status

- plan-ready

## Goal

Introduce a GitHub-edge reviewer-app adapter seam that normalizes per-app current-head coverage, run status, verdict, actionable feedback, and unresolved-feedback facts so PR lifecycle and guarded landing can make deterministic decisions without hardcoded app-specific parsing in generic snapshot policy.

## Scope

- add a normalized reviewer-app snapshot contract derived from raw GitHub PR review surfaces
- add a pluggable GitHub-side reviewer-app adapter registry that owns app-specific parsing rules
- add a first real adapter for `devin`
- add a compatibility adapter path that preserves current generic review-bot and approved-bot behavior while policy migrates to the normalized snapshot seam
- update PR lifecycle and guarded landing policy to consume normalized reviewer-app snapshots for required reviewer coverage, explicit pass/issues-found verdicts, and unresolved reviewer feedback
- add operator-visible reviewer-app posture projection where needed to debug coverage/verdict decisions
- add unit, integration, and e2e coverage for current-head, stale-head, missing, running, pass, and issues-found reviewer-app outcomes

## Non-goals

- full adapter rollout for every existing or future reviewer app in this PR
- Linear or other non-GitHub tracker parity
- redesigning human review policy or plan review workflow
- changing the overall PR lifecycle topology beyond replacing brittle reviewer-app inference with normalized reviewer facts
- remote reviewer orchestration, retry triggering, or bot command APIs
- introducing one-of/all-of reviewer quorum policy beyond the narrow seam needed for this issue

## Current Gaps

- `src/tracker/pull-request-snapshot.ts` mixes transport-derived review surfaces, app-specific string heuristics, and policy-oriented gating facts in one module
- current state only partially distinguishes reviewer-app concepts:
  - generic actionable bot feedback via `reviewBotLogins`
  - required reviewer presence via `approvedReviewBotLogins`
  - ad hoc status-context matching via `APPROVED_REVIEW_BOT_STATUS_CONTEXTS`
- the current snapshot does not model coverage, running/completed status, verdict, and unresolved/actionable feedback separately per reviewer app
- policy can still treat a PR as landable when a reviewer app clearly reported issues outside the currently recognized unresolved-thread or classified-comment paths
- app-specific evidence and debugging facts are not carried through a dedicated normalized surface for observability

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: deterministic rules for when required reviewer apps count as covered, when explicit `issues-found` verdicts require rework, and when landing needs explicit `pass`
  - does not belong: Devin-specific strings, GitHub comment/review object traversal, or status-context parsing
- Configuration Layer
  - belongs: typed workflow config for stable reviewer-app keys and the minimum accepted/required policy flags needed for this slice
  - does not belong: PR lifecycle evaluation or adapter parsing logic
- Coordination Layer
  - belongs: consume normalized lifecycle and landing-blocked outcomes derived from reviewer-app snapshots
  - does not belong: GitHub review surface parsing or app-specific heuristics
- Execution Layer
  - belongs: no workspace or runner changes in this slice
  - does not belong: reviewer-app normalization or landing policy
- Integration Layer
  - belongs: GitHub transport reads, raw-surface aggregation, reviewer-app adapter registry, per-app parsing, normalized reviewer snapshot creation
  - does not belong: orchestrator retry policy, operator command sequencing, or TUI-only presentation logic
- Observability Layer
  - belongs: project normalized reviewer coverage/verdict/unresolved posture into status and report surfaces when needed for operator debugging
  - does not belong: re-parsing raw GitHub comments/reviews/checks to rediscover reviewer-app state

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts` and `src/config/workflow.ts`
  - add the narrowest repo-owned config seam for named reviewer apps and required/accepted policy in GitHub-compatible trackers
- `src/tracker/`
  - separate reviewer-app transport aggregation, normalization, and policy
  - introduce:
    - a raw GitHub review-surface input shape for adapters
    - a normalized reviewer-app snapshot contract
    - an adapter registry/factory
    - a `devin` adapter
    - a compatibility adapter for existing generic bot-login behavior
  - update PR snapshot composition to embed normalized reviewer-app facts rather than scattered booleans and hardcoded login/status matching
- `src/tracker/pull-request-policy.ts` and `src/tracker/guarded-landing.ts`
  - consume normalized reviewer-app coverage/verdict/unresolved state
- `src/tracker/service.ts` and any affected domain types
  - carry precise blocked/waiting reasons from the normalized reviewer state
- observability/docs/tests
  - expose enough reviewer-app posture to explain why a PR is waiting, degraded, or in rework

### Does not belong in this issue

- runner prompt changes
- workspace or orchestration retry refactors
- GraphQL transport rewrites beyond what the normalized adapter seam immediately needs
- broad lifecycle-domain renaming unrelated to reviewer-app semantics
- full removal of existing bot-login compatibility if that would broaden the PR beyond one slice

## Layering Notes

- `config/workflow`
  - owns stable reviewer-app configuration
  - should not encode GitHub parsing rules or landing decisions
- `tracker`
  - owns raw GitHub review-surface aggregation plus reviewer-app normalization
  - should keep transport, adapter parsing, and PR policy in separate modules
- `workspace`
  - unchanged
- `runner`
  - unchanged
- `orchestrator`
  - consumes normalized lifecycle kinds and blocked reasons only
  - must not inspect reviewer keys, bot logins, review bodies, or status contexts directly
- `observability`
  - renders normalized reviewer posture and evidence summaries
  - must not infer reviewer state from raw tracker payloads outside the normalized snapshot

## Slice Strategy And PR Seam

Keep this as one reviewable PR focused on a single tracker-boundary seam:

1. add a normalized reviewer-app snapshot contract and GitHub adapter registry
2. ship one real `devin` adapter plus one compatibility adapter for existing generic bot-login behavior
3. migrate PR lifecycle and guarded landing to consume normalized reviewer-app facts
4. update docs/status/tests to explain the new deterministic reviewer posture

Deferred:

- native adapters for Greptile, Cursor Bugbot, or other reviewer apps beyond compatibility fallback
- richer reviewer policy such as one-of/all-of quorum, optional-but-observed apps, or weighted reviewers
- non-GitHub tracker implementations of reviewer-app normalization
- dedicated reviewer-app dashboards beyond the minimum operator-visible posture needed for debugging this slice

This seam is reviewable because it isolates reviewer-app semantics at the integration edge while preserving the rest of the orchestration lifecycle model and existing runner/workspace behavior.

## Runtime State Model

This issue changes stateful PR handoff behavior, so reviewer-app state must be explicit.

### Per-reviewer normalized states

For each configured reviewer app on the current PR head:

1. `missing`
   - no current-head evidence that the reviewer app ran
2. `running`
   - current-head evidence indicates the reviewer app has started but not reached a terminal verdict
3. `completed-pass`
   - current-head evidence shows the reviewer app completed with an explicit pass / no-issues verdict
4. `completed-issues-found`
   - current-head evidence shows the reviewer app completed with an explicit issues-found verdict
5. `completed-unknown`
   - current-head evidence shows the reviewer app ran, but the adapter cannot classify a deterministic pass/fail verdict

Each normalized reviewer snapshot also carries:

- `coverage`: `missing | observed`
- `status`: `running | completed | unknown`
- `verdict`: `pass | issues-found | unknown`
- `actionableFeedback`
- `unresolvedFeedbackIds`
- evidence facts for debugging

### Aggregate policy states relevant to this issue

- `awaiting-system-checks`
  - CI or reviewer app execution is still naturally pending
- `degraded-review-infrastructure`
  - required reviewer coverage for the current head is still missing after the normal check surface has settled
- `awaiting-human-review`
  - human review debt remains without automated reviewer-app issues forcing a follow-up run
- `rework-required`
  - a reviewer app explicitly found issues on the current head, or actionable reviewer feedback remains
- `awaiting-landing-command`
  - required reviewer apps have explicit current-head pass coverage and no reviewer-app/human blockers remain
- `awaiting-landing`
  - `/land` observed; guarded landing still re-checks normalized reviewer-app facts
- `handoff-ready`
  - merge observed

### Allowed transitions relevant to this issue

- `awaiting-system-checks` -> `degraded-review-infrastructure`
  - normal check stabilization has completed and a required reviewer app is still `missing`
- `awaiting-system-checks` -> `rework-required`
  - a required or accepted reviewer app reaches `completed-issues-found`
- `awaiting-system-checks` -> `awaiting-landing-command`
  - required reviewer apps reach `completed-pass`, all checks are green, and no actionable feedback remains
- `degraded-review-infrastructure` -> `awaiting-system-checks`
  - a reviewer app is now observed but still `running`
- `degraded-review-infrastructure` -> `rework-required`
  - a reviewer app later completes with `issues-found`
- `degraded-review-infrastructure` -> `awaiting-landing-command`
  - a reviewer app later completes with explicit `pass`
- `awaiting-landing-command` -> `rework-required`
  - a new head or fresh reviewer result introduces issues-found or actionable feedback
- `awaiting-landing-command` -> `degraded-review-infrastructure`
  - a new head invalidates stale reviewer coverage and no current-head required reviewer evidence exists
- `awaiting-landing` -> `rework-required`
  - guarded landing re-check observes `issues-found` or actionable feedback
- `awaiting-landing` -> `degraded-review-infrastructure`
  - guarded landing re-check observes required reviewer coverage missing on the approved/current head
- `awaiting-landing` -> `handoff-ready`
  - guarded landing succeeds and merge is observed

### Coordination Decision Rules

- policy must treat reviewer-app coverage, run status, verdict, and unresolved/actionable feedback as separate normalized inputs
- a successful non-reviewer CI status must never satisfy reviewer coverage or verdict
- required reviewer apps must have current-head `coverage=observed`, terminal `status=completed`, explicit `verdict=pass`, and no unresolved/actionable reviewer feedback before landing is eligible
- stale reviewer evidence from prior heads must never satisfy current-head policy
- keep orchestrator logic tracker-neutral by exposing only normalized lifecycle kinds and summaries above the tracker boundary

## Failure-Class Matrix

| Observed condition                                                                                                                   | Local facts available                             | Normalized tracker facts available                                                            | Expected decision                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Required reviewer app has no current-head evidence and checks are still pending or in no-check stabilization                         | no landing attempt active                         | reviewer coverage = `missing`; check surface unsettled                                        | stay in `awaiting-system-checks`                                                     |
| Required reviewer app has no current-head evidence after checks settle                                                               | no landing attempt active                         | reviewer coverage = `missing`; check surface settled                                          | report `degraded-review-infrastructure`                                              |
| Required reviewer app has a current-head running status/check but no terminal verdict yet                                            | no landing attempt active                         | reviewer coverage = `observed`; status = `running`; verdict = `unknown`                       | stay in `awaiting-system-checks`                                                     |
| Required reviewer app explicitly reports pass on current head                                                                        | no landing attempt active                         | coverage = `observed`; status = `completed`; verdict = `pass`; unresolved feedback = none     | allow `awaiting-landing-command` when other gates pass                               |
| Required reviewer app explicitly reports issues on current head through a top-level review/comment without unresolved thread objects | no landing attempt active                         | coverage = `observed`; verdict = `issues-found`; actionable feedback > 0 or verdict gate fail | enter `rework-required`                                                              |
| Reviewer app ran only on an older head, then a new commit landed                                                                     | no landing attempt active or stale `/land` exists | current-head reviewer coverage = `missing`                                                    | fall back to waiting/degraded based on check-settled posture                         |
| `/land` exists, but guarded landing re-check still sees required reviewer app `missing` or `completed-unknown`                       | landing approval recorded                         | required reviewer landing gate unsatisfied                                                    | block landing and return degraded/waiting lifecycle consistent with normalized state |
| Compatibility adapter sees generic approved-bot review evidence but no explicit app-specific adapter configured                      | no landing attempt active                         | compatibility reviewer snapshot satisfies current policy                                      | preserve current behavior while new adapter seam is adopted                          |

## Storage / Persistence Contract

- no new durable store is introduced
- workflow config remains the source of truth for named reviewer-app policy
- normalized reviewer-app snapshots remain ephemeral tracker state derived from GitHub review surfaces for the current head
- operator artifacts/status may persist normalized reviewer summaries/evidence references, but not raw GitHub-authored payloads as the primary contract

## Observability Requirements

- status and report surfaces should be able to show, at minimum:
  - which reviewer apps are configured and required
  - whether each required reviewer app is missing, running, pass, issues-found, or unknown on the current head
  - whether blocked/rework decisions came from coverage, verdict, or unresolved/actionable feedback
- summaries should distinguish:
  - ordinary system-check waiting
  - degraded reviewer coverage because a required app never produced current-head output
  - explicit reviewer-app issues requiring rework
  - landing-ready posture with current-head pass coverage
- operator docs should explain that reviewer-app semantics now come from normalized adapters at the tracker edge

## Decision Notes

- Introduce a new additive reviewer-app config seam now instead of overloading `review_bot_logins` and `approved_review_bot_logins` further. Those fields describe author classes, not stable reviewer-app identities or policy.
- Keep a compatibility adapter in the first slice so this PR can land without forcing immediate native adapters for every existing reviewer app.
- Make `devin` the first explicit adapter because the issue specifically calls out top-level review-summary semantics that the current generic surface handles poorly.
- Prefer a dedicated raw-review-surface input shape for adapters so app-specific parsers do not depend directly on GitHub client response types across the codebase.

## Implementation Steps

1. Add typed workflow/domain config for named reviewer apps in GitHub-compatible trackers, including the minimum policy flags needed for this slice.
2. Introduce a tracker-side normalized reviewer-app snapshot contract plus a raw GitHub reviewer-surface input shape.
3. Extract current reviewer-app parsing out of `src/tracker/pull-request-snapshot.ts` into:
   - adapter interfaces/types
   - adapter registry/factory
   - compatibility adapter for existing generic bot-login behavior
   - `devin` adapter
4. Update PR snapshot creation to aggregate per-app reviewer snapshots and derive policy-oriented aggregate facts from that normalized collection instead of scattered booleans and hardcoded status-context tables.
5. Update `src/tracker/pull-request-policy.ts` to consume normalized reviewer-app snapshots for:
   - waiting on running reviewer apps
   - degraded required coverage when reviewer apps remain missing after checks settle
   - rework when a reviewer app explicitly reports issues or unresolved reviewer feedback
   - landing eligibility only after explicit required-app pass coverage
6. Update guarded landing and tracker service result types so landing uses the same normalized reviewer-app gate and summary vocabulary.
7. Thread reviewer-app posture through any affected observability/report/status surfaces without leaking raw GitHub parsing upward.
8. Update workflow docs/README/operator docs for the new reviewer-app config seam and deterministic landing policy.
9. Add targeted tests across unit, integration, and e2e layers using shared fixtures/builders where reviewer-app surface setup repeats.
10. Run local self-review and repository gates before PR update/open:

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main` if available and reliable

## Tests And Acceptance Scenarios

### Unit

- reviewer-app adapter registry selects `devin` and compatibility adapters deterministically from config
- `devin` adapter classifies current-head results as `missing`, `running`, `pass`, `issues-found`, and `unknown`
- stale prior-head reviewer evidence does not satisfy current-head coverage or verdict
- policy maps:
  - required reviewer `missing` after check stabilization -> `degraded-review-infrastructure`
  - required reviewer `running` -> `awaiting-system-checks`
  - required reviewer `issues-found` -> `rework-required`
  - required reviewer `pass` with no other blockers -> `awaiting-landing-command`
- guarded landing blocks when required reviewer apps are `missing`, `running`, or `unknown`

### Integration

- `GitHubTracker.inspectIssueHandoff()` reports `awaiting-system-checks` while Devin is still running on the current head
- `GitHubTracker.inspectIssueHandoff()` reports `degraded-review-infrastructure` when required Devin coverage is still missing after checks settle
- `GitHubTracker.inspectIssueHandoff()` reports `rework-required` when Devin leaves a current-head summary that explicitly says issues were found, even if no unresolved thread objects exist
- `GitHubTracker.inspectIssueHandoff()` reports `awaiting-landing-command` when Devin explicitly passes on the current head and all other gates are green
- `GitHubTracker.executeLanding()` fail-closes when stale or unknown reviewer-app posture makes landing non-deterministic

### End-to-End

- factory run opens a PR, CI turns green, required Devin output never appears, and the run stays visibly degraded instead of becoming landable
- factory run opens a PR, Devin reports issues on the current head via summary review/comment, and Symphony schedules rework rather than waiting for `/land`
- factory run opens a PR, Devin initially runs, later emits an explicit current-head pass, and the run advances to `awaiting-landing-command`
- after a follow-up push, prior-head Devin pass evidence no longer satisfies the new head until new current-head reviewer output arrives

### Acceptance Scenarios

1. Devin is configured as required, CI is green, and Devin never produces current-head output; Symphony reports degraded reviewer infrastructure instead of landing-ready posture.
2. Devin is configured as required and reports a current-head running status; Symphony keeps waiting rather than degrading or landing.
3. Devin is configured as required and reports `found 3 potential issues` on the current head; Symphony enters `rework-required` even without unresolved thread objects.
4. Devin is configured as required and reports `No Issues Found` on the current head; Symphony can advance to `/land` once other gates are green.
5. After a new push, only stale prior-head Devin evidence exists; Symphony falls back to waiting/degraded until new current-head reviewer output appears.

## Exit Criteria

1. reviewer-app semantics are parsed through a pluggable tracker-edge adapter seam rather than hardcoded inside generic PR snapshot logic
2. `devin` is modeled through that seam with deterministic current-head coverage and verdict handling
3. required landing policy depends on normalized reviewer-app coverage, explicit pass verdicts, and unresolved/actionable reviewer feedback
4. a PR cannot become landable when a required reviewer app explicitly reported issues on the current head
5. status/docs/tests make current-head reviewer coverage and verdict posture inspectable
6. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass

## Deferred To Later Issues Or PRs

- native adapters for additional reviewer apps beyond `devin` and the compatibility fallback
- richer reviewer policy such as all-of/one-of groups, quorum counts, or optional accepted-only reviewer classes
- non-GitHub reviewer-app normalization
- automatic reviewer reruns, escalation comments, or recovery automation when reviewer coverage is missing
- broader cleanup that fully removes legacy bot-login fields after native adapter migration is complete
