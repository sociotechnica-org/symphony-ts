# Issue 263 Plan: Stop Workers From Opening Draft PRs By Default

## Status

`plan-ready`

## Goal

Make the default Symphony worker contract open implementation pull requests ready for review, not as drafts, unless draft behavior is explicitly requested by repository-owned policy.

## Scope

1. identify the repo-owned worker-contract seam that currently leaves pull-request draft state implicit
2. update the self-hosting `WORKFLOW.md` prompt contract so normal implementation PRs are opened ready for review by default
3. update the third-party starter workflow template so newly scaffolded workflows carry the same non-draft default
4. add regression coverage that keeps the default worker contract explicit and prevents silent reintroduction of accidental draft PR openings
5. document the intentional boundary between the default policy and any future explicit draft-PR option

## Non-goals

1. redesigning the GitHub tracker, guarded landing, or review-state machinery
2. adding a new workflow frontmatter flag in this slice unless implementation evidence shows the prompt contract is insufficient to express the default safely
3. changing how Symphony detects or reports already-draft pull requests after they exist
4. broadening this issue into reviewer-app policy redesign or degraded-review-infrastructure handling beyond the accidental-draft trigger
5. inventing runtime enforcement that rewrites PR state after the worker opens it, unless the current implementation evidence contradicts the prompt-first seam

## Current Gaps

1. the checked-in self-hosting `WORKFLOW.md` requires opening or updating a PR, but it does not state that the default PR must be ready for review rather than draft
2. the third-party workflow template in `src/templates/third-party-workflow.ts` carries the same omission, so new instances inherit the ambiguity
3. the runtime already treats draft PRs as non-landable and this repo’s reviewer-app behavior suppresses expected output while a PR remains draft, so the missing default becomes a real factory stall rather than a cosmetic issue
4. existing tests cover plan-review protocol, guarded landing draft rejection, and general workflow rendering, but they do not pin the worker contract to a non-draft PR default

## Spec / Layer Mapping

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction-level mapping in `docs/architecture.md`.

- Policy Layer
  - Belongs here: the repository-owned default that a normal implementation PR is opened ready for review, and that draft PRs require explicit repository policy.
  - Does not belong here: GitHub API transport details or tracker-side review-state parsing.
- Configuration Layer
  - Belongs here: prompt/template wording in `WORKFLOW.md` and starter workflow generation that makes the default explicit.
  - Does not belong here: adding a new frontmatter option unless the implementation proves prompt policy alone is not a sufficient seam.
- Coordination Layer
  - Belongs here: no orchestration-state change is planned for this slice.
  - Does not belong here: retry, reconciliation, or handoff-state refactors.
- Execution Layer
  - Belongs here: the worker-run contract that governs how the agent opens the PR during normal delivery.
  - Does not belong here: tracker lifecycle policy or reviewer-app decision logic.
- Integration Layer
  - Belongs here: no GitHub transport or normalization change is expected unless a targeted test helper needs to assert rendered prompt content in an integration-style workflow.
  - Does not belong here: mixing GitHub API policy into prompt/template rendering.
- Observability Layer
  - Belongs here: documentation and, if useful, tests that keep the operator-visible default aligned with the worker contract.
  - Does not belong here: using reports/status as the primary enforcement mechanism for PR draft state.

## Architecture Boundaries

### Belongs in this issue

1. self-hosting workflow prompt updates in `WORKFLOW.md`
2. starter workflow template updates in `src/templates/third-party-workflow.ts`
3. supporting documentation updates in `README.md` and workflow docs where the default PR behavior should be explicit
4. focused tests that verify the checked-in worker contract and generated workflow template both instruct ready-for-review PR creation by default

### Does not belong in this issue

1. tracker transport, normalization, or PR lifecycle refactors
2. new orchestrator runtime state around draft PR recovery
3. broad report-schema changes for draft-state attribution
4. a generalized per-repo PR-mode policy system unless the issue cannot be solved with the existing repo-owned prompt contract

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one seam: tighten the default worker contract for PR creation so both the self-hosting workflow and newly scaffolded workflows say the same thing about non-draft default behavior.

What lands in this PR:

1. explicit non-draft PR instructions in the checked-in workflow contract
2. matching instructions in the starter workflow template used by `symphony init`
3. tests and docs that keep the default visible and reviewable

Deferred from this PR:

1. any new frontmatter/config flag for intentionally opening draft PRs
2. runtime-side enforcement that mutates PR state after creation
3. report or status-surface expansion that explains draft-vs-ready causality in more detail

This seam stays reviewable because it does not mix tracker transport, normalization, lifecycle policy, and orchestration-state changes into a prompt-contract fix.

## Runtime State Model

This issue intentionally preserves the current runtime state model.

### States in play

1. `awaiting-human-handoff` during plan review
2. existing PR-centric follow-up states after the PR opens
3. guarded landing’s existing blocked condition for draft PRs

### Relevant behavior change

1. before this issue, the worker contract allows the PR-open step to be ambiguous about draft state
2. after this issue, the worker contract makes "ready for review by default" an explicit precondition of the normal PR-open step unless repository policy says otherwise

### Explicit non-transition

1. this issue must not add new runtime states, counters, or reconciliation branches for draft PR handling

## Failure-Class Matrix

| Observed condition                                               | Local facts available                              | Normalized tracker/runtime facts available                      | Expected decision                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Worker opens PR ready for review                                 | prompt/workflow says non-draft default             | PR is open and not draft                                        | normal CI/review follow-through                                                   |
| Worker opens PR as draft despite default prompt contract         | prompt/workflow says non-draft default             | PR is draft; reviewer-app output may stay absent                | treat as a worker-contract regression; preserve current runtime handling          |
| Repository explicitly wants draft PR behavior in the future      | repo-owned workflow or issue policy says so        | PR may be draft intentionally                                   | outside this slice; capture by explicit policy/config follow-up                   |
| Existing draft PR reaches guarded landing                        | no special local facts required                    | normalized PR snapshot says `draft: true`                       | keep current landing block behavior unchanged                                     |
| Self-hosting or scaffolded workflow loses the explicit default   | rendered workflow content no longer mentions ready | no runtime fact yet; regression appears at prompt/template seam | fail the regression tests before the change ships                                 |

## Storage / Persistence Contract

No new durable state is introduced.

1. the source of truth for the default behavior remains the checked-in workflow contract and starter workflow template
2. existing PR draft-state facts continue to come from the GitHub tracker snapshot
3. this issue should not add local caches, report stores, or tracker metadata solely to remember why a PR was draft

## Observability Requirements

1. operator-facing docs should describe that the normal Symphony loop opens PRs ready for review by default
2. the default should be explicit enough in checked-in prompt/template text that a reviewer can verify the behavior from the repo without inferring intent
3. tests should fail clearly if either the self-hosting workflow or starter template drops the non-draft default wording

## Implementation Steps

1. update the root `WORKFLOW.md` instructions so the worker opens or updates the PR ready for review by default and only uses draft mode when repository-owned policy explicitly asks for it
2. update `src/templates/third-party-workflow.ts` so newly scaffolded workflows carry the same default PR instruction
3. update `README.md` and any workflow guidance that describes the normal delivery loop so the ready-for-review default is visible to operators and third-party users
4. add or extend tests that pin:
   - the self-hosting workflow contract text
   - the starter workflow template output
   - any repo planning/contract checks that should guard the wording long-term
5. add one focused integration or end-to-end regression proving the rendered workflow used in factory tests includes the explicit non-draft default if the existing test seam can support it without broad harness churn
6. perform a local self-review pass if a reliable review tool is available, then run the repo-required checks

## Tests And Acceptance Scenarios

### Unit

1. a workflow/template contract test proves the self-hosting `WORKFLOW.md` instructs PRs to open ready for review by default
2. a template-rendering or init-path test proves `renderThirdPartyWorkflowTemplate` includes the same instruction
3. any existing planning/contract test updated for this behavior remains green

### Integration

1. if the init CLI or workflow-loading seam is the narrowest place to assert rendered content, verify the generated `WORKFLOW.md` for a third-party instance contains the explicit non-draft default

### End-to-end

1. a factory-oriented regression test or prompt-capture scenario proves the worker receives a workflow contract that explicitly prefers non-draft PR creation in the normal delivery loop

### Local Gate

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`

## Exit Criteria

1. the checked-in self-hosting workflow explicitly instructs non-draft PR creation by default
2. the third-party starter workflow template carries the same default
3. relevant docs describe the normal delivery loop as opening PRs ready for review unless draft behavior is explicitly requested
4. regression tests fail if that default wording disappears from the checked-in workflow/template seam
5. no tracker transport, normalization, or orchestration-state refactor is bundled into this PR

## Deferred To Later Issues Or PRs

1. an explicit workflow frontmatter option for repositories that intentionally want draft PRs
2. richer reporting on whether a PR was created as draft and why
3. runtime-side enforcement or remediation if real-world evidence shows prompt policy alone is insufficient

## Decision Notes

1. The current implementation evidence points to a prompt-contract gap rather than a runtime transport/config bug. The first slice should therefore tighten the repo-owned worker contract before introducing new runtime machinery.
2. If implementation uncovers a real code path that forces draft PR creation independently of the prompt, update this plan before widening the slice.
3. Guarded landing already blocks draft PRs. This issue should not repurpose landing logic into the primary prevention mechanism for accidental drafts.

## Revision Log

- 2026-03-30: Initial draft created for issue `#263`.
- 2026-03-30: Reviewed and marked `plan-ready` for human handoff.
