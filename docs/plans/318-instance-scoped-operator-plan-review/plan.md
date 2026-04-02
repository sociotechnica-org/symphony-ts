# Issue 318 Plan: Instance-Scoped Operator Plan Review For External Repositories

## Status

- plan-ready

## Goal

Make operator plan review instance-scoped so that when the checked-in Symphony operator loop is pointed at an external repository, the operator reviews `plan-ready` handoffs against the selected repository's own planning contract and docs instead of implicitly applying `symphony-ts` planning standards.

## Scope

1. make the operator prompt and skill explicit about the selected instance repository being the source of truth for plan-review rubric and relevant planning docs
2. expose any missing selected-instance path/context needed so the operator can reliably locate the external repository's `WORKFLOW.md`, `AGENTS.md`, `README.md`, and relevant docs during a wake-up cycle
3. update operator-facing docs so third-party operation explains the instance-scoped review rule clearly
4. add tests that pin the prompt and operator-loop contract so external-repository plan review no longer defaults to `symphony-ts` guidance

## Non-goals

1. changing the tracker-owned `tracker.plan_review` protocol markers, metadata labels, or reply-template contract introduced by issue `#316`
2. redesigning the operator wake-up sequence, detached runtime control, or release/report checkpoints
3. changing normalized tracker lifecycle states such as `awaiting-human-handoff`
4. building a generic cross-repository policy loader beyond the selected instance's checked-in docs and workflow path
5. changing worker prompt rules for implementation work outside the operator's plan-review checkpoint

## Current Gaps

1. [`skills/symphony-operator/operator-prompt.md`](../../../../skills/symphony-operator/operator-prompt.md) still opens with "this repository", which is accurate for self-hosting but ambiguous or misleading when the operator repo and selected instance repo differ
2. the operator skill describes the selected workflow's `tracker.plan_review` markers, but it does not explicitly require the review rubric itself to come from the selected repository's own planning docs
3. the checked-in operator docs are written primarily from the self-hosting perspective and do not clearly separate operator-repo tooling from selected-instance review authority
4. the operator loop exports the selected workflow path, but it does not yet surface a dedicated selected-instance root/path contract for prompt use
5. current operator-loop tests pin checkpoint ordering and per-instance state isolation, but they do not pin the external-instance plan-review rubric boundary

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in [`docs/architecture.md`](../../architecture.md).

- Policy Layer
  - belongs: the rule that plan-review quality is judged against the selected repository's own planning contract, not the engine checkout's defaults
  - does not belong: hard-coded `symphony-ts` architecture expectations silently applied to unrelated repositories
- Configuration Layer
  - belongs: selected-instance path derivation or exported context needed to make the chosen repository explicit to the operator prompt
  - does not belong: tracker comment parsing or human-decision marker logic
- Coordination Layer
  - belongs: no lifecycle or retry changes for this slice; the operator still reacts to the same `awaiting-human-handoff` checkpoint
  - does not belong: new orchestration states or retry/reconciliation logic
- Execution Layer
  - belongs: operator prompt/skill wording and any instance-scoped environment contract the wake-up loop must provide to let the operator inspect the right repository
  - does not belong: tracker-specific review parsing or issue-thread mutation rules
- Integration Layer
  - belongs: any operator-loop path plumbing that resolves the selected instance root from the workflow path and passes it into the prompt environment
  - does not belong: GitHub transport or tracker lifecycle policy refactors unrelated to operator context
- Observability Layer
  - belongs: operator-facing docs/tests that make the selected-instance review source of truth inspectable
  - does not belong: a new dashboard, state artifact, or reporting surface for this slice

## Architecture Boundaries

### Belongs in this issue

1. operator prompt and skill assets under `skills/symphony-operator/`
   - make the selected instance repository explicit during plan review
   - require review against that repository's `WORKFLOW.md`, `AGENTS.md`, `README.md`, and relevant docs when they exist
2. operator-loop execution contract
   - expose any missing selected-instance root/path environment values derived from the chosen workflow path
   - keep the operator running from the engine checkout while making the review authority instance-scoped
3. operator-facing docs
   - update third-party/operator docs to explain that the operator repo provides tooling, while the selected instance repo provides planning standards
4. tests
   - pin prompt wording, exported instance context, and external-instance review instructions

### Does not belong in this issue

1. tracker `plan_review` protocol redesign or new workflow frontmatter
2. orchestrator dispatch/retry/handoff-state changes
3. worker implementation prompt redesign outside what is required to clarify the operator checkpoint
4. new durable per-instance policy stores outside the repository-owned checked-in docs

## Layering Notes

- `config/workflow`
  - may contribute resolved instance-path data if the cleanest seam needs it
  - should not gain operator-specific plan-review policy logic
- `tracker`
  - remains the owner of plan-review markers and lifecycle normalization
  - should not become the source of plan-review rubric text
- `workspace`
  - remains unchanged
  - should not participate in operator review-rubric selection
- `runner`
  - owns the operator-loop launch environment only insofar as selected-instance context must be surfaced cleanly
  - should not infer repository policy from tracker comments
- `orchestrator`
  - remains unchanged and continues to consume normalized handoff lifecycle only
  - should not branch on whether the operator is self-hosting or reviewing an external repo
- `observability`
  - owns clear operator-facing guidance/tests about where review authority comes from
  - should not invent a second source of truth for repository planning rules

## Slice Strategy And PR Seam

Land this as one reviewable PR focused on one seam: preserve the existing operator loop and plan-review protocol, but make the plan-review rubric explicitly instance-scoped for non-default workflows.

This stays reviewable because it limits the change to:

1. operator prompt/skill wording
2. small operator-loop context plumbing
3. targeted operator docs
4. prompt/loop contract tests

This issue should not expand into tracker protocol changes, new runtime states, or a larger external-repository productization effort.

## Runtime State Model

This slice preserves the existing operator and tracker lifecycle states. The behavior change is which repository supplies the review rubric once the operator reaches the existing human-handoff checkpoint.

### States in play

1. operator wake-up selects an instance via `--workflow`
2. tracker reports issue lifecycle `awaiting-human-handoff`
3. operator reviews the plan against the selected repository's planning contract
4. operator posts the selected workflow's configured decision marker

### Explicit non-changes

1. no new handoff lifecycle kinds
2. no new operator checkpoint states
3. no retry, reconciliation, or lease behavior changes

## Failure-Class Matrix

| Observed condition                                                          | Local facts available                           | Selected-instance facts available          | Expected decision                                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Operator runs from `symphony-ts` root against `../target-repo/WORKFLOW.md`  | operator checkout paths, selected workflow path | selected instance root and repo docs exist | review the plan against `../target-repo` docs, not `symphony-ts` docs                                                           |
| Selected instance has `WORKFLOW.md` but no `AGENTS.md`                      | workflow path and instance root                 | no `AGENTS.md`, maybe `README.md` and docs | continue with the selected repository's checked-in instructions that do exist; do not fall back to `symphony-ts` planning rules |
| Selected instance overrides `tracker.plan_review` markers                   | workflow config available                       | selected marker strings resolved           | use selected marker protocol plus selected repository rubric                                                                    |
| Self-hosting `symphony-ts` workflow is selected                             | operator checkout equals instance root          | local repo docs are the selected repo docs | preserve current self-hosting behavior                                                                                          |
| Prompt still says "this repository" without selected-instance clarification | operator checkout root visible                  | external instance root also exists         | invalid implementation for this issue; prompt must explicitly distinguish tooling repo from selected instance review authority  |

## Storage / Persistence Contract

1. the selected repository's checked-in `WORKFLOW.md`, `AGENTS.md`, `README.md`, and relevant docs remain the canonical plan-review rubric inputs
2. operator-loop local state under `.ralph/instances/<instance-key>/` remains unchanged and is not a policy source of truth
3. no new durable policy artifacts should be introduced for this slice

## Observability Requirements

1. operator-facing prompt/doc text must make it obvious which repository owns the review rubric for the current wake-up
2. external-instance behavior must be pinned in automated tests so future prompt edits do not regress to `symphony-ts`-specific review standards
3. self-hosting behavior must remain intact and obvious

## Implementation Steps

1. add or refine selected-instance path derivation/export in the operator loop if the current `SYMPHONY_OPERATOR_WORKFLOW_PATH` contract is not explicit enough for prompt consumers
2. update [`skills/symphony-operator/operator-prompt.md`](../../../../skills/symphony-operator/operator-prompt.md) so plan review explicitly:
   - distinguishes the operator tooling repo from the selected instance repo
   - reads planning standards from the selected instance's checked-in docs
   - avoids implicitly applying `symphony-ts` architecture rules to external repositories
3. update [`skills/symphony-operator/SKILL.md`](../../../../skills/symphony-operator/SKILL.md) with the same instance-scoped review rule and third-party nuance
4. update [`docs/guides/operator-runbook.md`](../../guides/operator-runbook.md) and any nearby operator-facing docs that currently imply the operator repo is the review authority
5. add/update tests for:
   - operator-loop prompt text for external workflows
   - exported selected-instance path/context if new env surface is added
   - third-party/operator docs or contract tests where the checked-in wording is the primary deliverable
6. run local QA: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`

## Tests And Acceptance Scenarios

### Unit / Contract

1. planning/operator contract tests keep the operator guidance explicit that plan review uses the selected repository's own docs and planning standards
2. if a new selected-instance environment variable is added, unit or integration coverage pins its resolved value

### Integration

1. when the operator loop is launched with `--workflow <external-instance>/WORKFLOW.md`, the prompt captured from the loop instructs the operator to review plans against the selected instance repository rather than "this repository"
2. self-hosting operator-loop prompt behavior remains valid when the selected workflow belongs to the engine checkout itself

### End-to-end

1. given a third-party instance with its own planning contract, an operator wake-up reviewing a `plan-ready` issue has enough prompt/context to apply that contract instead of `symphony-ts` architecture rules

### Local Gate

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. local self-review if a reliable review command is available

## Exit Criteria

1. operator guidance clearly states that the selected instance repository owns the plan-review rubric
2. external-instance operator runs have explicit selected-instance path/context instead of relying on ambiguous "this repository" wording
3. automated tests cover the external-instance prompt/rubric boundary
4. self-hosting behavior remains unchanged

## Deferred Work

1. generic cross-repository policy discovery beyond checked-in repository docs
2. any broader operator prompt redesign unrelated to instance-scoped plan review
3. tracker-side enforcement that a repository publishes particular planning docs

## Decision Notes

1. Keep the review authority in checked-in repository docs instead of inventing a second operator-local policy store. That preserves repo ownership and keeps external repositories inspectable.
2. Prefer a small operator-loop context seam over tracker or orchestrator changes. The bug is in review context/rubric ownership, not in lifecycle normalization.
3. Preserve self-hosting behavior as the default case of the same instance-scoped rule: when the selected instance is `symphony-ts`, `symphony-ts` docs are the right rubric; when it is external, they are not.

## Revision Log

- 2026-04-02: Initial plan created for issue `#318` and prepared for plan-review handoff.
