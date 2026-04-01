# Issue 299 Plan: Reset Implementation Turn Budget After Approved Plan Handoff

## Goal

Make a post-plan-review implementation rerun deterministic and usable: once a
worker has reached `plan-ready` and a human replies with `Plan review:
approved` or `Plan review: waived`, the next worker run must resume with a
fresh implementation turn budget and prompt-visible context that the plan gate
has already been satisfied.

## Scope

In scope:

- GitHub bootstrap plan-review normalization for approved, waived, and
  changes-requested replies after a `plan-ready` handoff
- prompt/context plumbing so pre-PR lifecycle facts remain visible to the next
  worker run instead of collapsing to a generic null PR state
- orchestrator handling for pre-PR implementation resumes after approved plan
  handoff
- regression coverage for the `#289` control path, including a prompt-sensitive
  e2e fixture that proves the resumed run receives usable implementation
  context and can make progress

Out of scope:

- redesigning the overall plan review workflow or accepted review markers
- changing `agent.max_turns` schema or turning it into separate configurable
  plan-phase and implementation-phase budgets
- Linear tracker lifecycle redesign beyond any shared prompt-context helpers
- runner transport changes, workspace retention changes, or unrelated retry
  backoff policy changes

## Non-Goals

- invent a new tracker transport protocol for plan review
- add a durable orchestrator-side ledger of every prior turn across runs
- change how PR review, CI follow-up, or landing states work
- backfill or rewrite historical issue artifacts for already completed runs

## Symphony Layer Mapping

- Policy Layer
  - Belongs here: the repo-owned rule that approved or waived plan review means
    "resume implementation on the same issue branch with a fresh worker run",
    while changes-requested means "revise the plan and post a fresh
    `plan-ready` handoff".
  - Does not belong here: runner transport details or workspace bootstrap
    mechanics.
- Configuration Layer
  - Belongs here: prompt-builder contract changes required to expose normalized
    lifecycle kind/summary to the worker prompt even when no PR exists yet.
  - Does not belong here: tracker-specific comment parsing rules or retry
    queues.
- Coordination Layer
  - Belongs here: orchestrator handling for a new worker run after
    `awaiting-human-handoff`, including keeping the implementation rerun on a
    fresh run attempt and passing normalized lifecycle context into the prompt
    and continuation guidance.
  - Does not belong here: raw GitHub comment parsing or issue-comment wording.
- Execution Layer
  - Belongs here: none beyond preserving the existing per-run `agent.max_turns`
    contract.
  - Does not belong here: any new runner session-reuse or workspace-retention
    behavior; this issue is not a runner/workspace fix.
- Integration Layer
  - Belongs here: GitHub plan-review normalization that distinguishes "waiting
    for review" from "approved/waived, resume implementation" and
    "changes-requested, revise plan", while still using existing GitHub issue
    comments as the system of record.
  - Does not belong here: orchestrator retry counters or prompt rendering.
- Observability Layer
  - Belongs here: status/artifact assertions needed to keep the resumed
    implementation phase inspectable in tests.
  - Does not belong here: inventing a new operator dashboard feature for this
    fix.

## Current Gap

Issue `#289` exposed a control-path bug after the repo adopted the mandatory
plan-review station:

1. attempt 1 used the full `agent.max_turns` budget while producing the plan
   and posting `Plan status: plan-ready`
2. a human approved the plan on the issue thread
3. the next worker run re-entered the issue with no PR yet, but Symphony
   normalized that state back to a generic `missing-target`
4. the orchestrator then dropped that `missing-target` lifecycle to `null`
   when building the prompt, so the resumed worker prompt could not see that
   the plan gate had already been satisfied
5. the rerun therefore did not receive explicit "resume implementation now"
   context, and the issue could fail again with the same max-turn
   `missing-target` outcome without implementation progress

The repo already treats `agent.max_turns` as a per-run budget. The gap is that
the post-approval rerun does not carry forward the phase boundary that should
make the fresh implementation budget usable.

## Architecture Boundaries

Keep the fix on one reviewable seam:

- `src/tracker/plan-review-policy.ts` should own normalization of issue-thread
  plan-review decisions into stable pre-PR lifecycle summaries.
- `src/tracker/github.ts` should keep using normalized lifecycle facts from the
  tracker edge instead of inventing orchestrator-specific special cases.
- `src/config/workflow.ts`, `src/domain/prompt-context.ts`, and
  `src/tracker/prompt-context.ts` should own the worker prompt contract for
  lifecycle visibility.
- `src/orchestrator/service.ts` should pass normalized lifecycle context into
  worker turns and continuation prompts without treating pre-PR implementation
  resumes as tracker-specific shell lore.

What does not belong in this slice:

- mixing GitHub comment fetching/parsing with prompt rendering logic
- adding workspace markers, local files, or runner metadata just to remember
  that plan review was approved
- creating a brand-new lifecycle family for every plan-review subcase unless
  the existing normalized lifecycle kinds cannot express the behavior cleanly

## Slice Strategy And PR Seam

Land one PR focused on "approved plan handoff resumes implementation with
prompt-visible context":

1. normalize approved/waived/changes-requested plan-review decisions into
   actionable pre-PR lifecycle summaries at the tracker edge
2. surface general lifecycle context to the worker prompt independently from
   PR-only context
3. add regression tests that fail on the current bug and pass once resumed
   implementation receives the right context

This is reviewable in one PR because it stays on one runtime seam:
plan-review lifecycle normalization plus the prompt/orchestrator contract that
consumes it. It does not mix workspace cleanup, runner transport, and tracker
transport changes.

Deferred from this PR:

- configurable separate plan-budget and implementation-budget knobs
- richer operator UI for "approved plan, implementation not yet started"
- Linear-specific plan-review resume semantics unless the shared prompt-context
  contract needs a small follow-on adjustment

## Runtime State Machine

This issue changes orchestration around retries, continuations, and handoff
states, so the runtime model must stay explicit.

States:

1. `missing-target / initial`
   - no PR exists and no valid plan-review handoff has been observed yet
2. `awaiting-human-handoff`
   - latest valid issue-thread signal is `Plan status: plan-ready`
3. `missing-target / approved-plan-resume`
   - no PR exists, but the latest relevant plan-review signal is
     `approved` or `waived`, so the next worker run should resume
     implementation on the same branch with a fresh run attempt
4. `missing-target / revise-plan`
   - no PR exists, but the latest relevant plan-review signal is
     `changes-requested`, so the next worker run should revise the plan rather
     than start implementation
5. `rework-required`
   - PR exists and actionable review/check feedback requires more code changes
6. `awaiting-system-checks` / `awaiting-human-review` / `awaiting-landing*`
   - existing post-PR handoff states remain unchanged
7. `handoff-ready`
   - PR merged / terminal success
8. `attempt-failed`
   - worker run exhausted its per-run budget or otherwise failed and entered
     retry/failure handling

Transitions:

1. initial `missing-target` -> `awaiting-human-handoff`
   - worker posts `Plan status: plan-ready`
2. `awaiting-human-handoff` -> `missing-target / approved-plan-resume`
   - human posts `Plan review: approved` or `Plan review: waived`
3. `awaiting-human-handoff` -> `missing-target / revise-plan`
   - human posts `Plan review: changes-requested`
4. `missing-target / approved-plan-resume` -> implementation worker run
   - next run attempt starts with turn 1 of `agent.max_turns` and prompt-visible
     lifecycle summary that plan review is already satisfied
5. `missing-target / revise-plan` -> plan revision worker run
   - next run attempt starts with turn 1 and prompt-visible lifecycle summary
     that the plan must be revised and re-posted
6. any active worker run -> `attempt-failed`
   - run exits unsuccessfully or finishes with actionable work still remaining
     after its per-run `agent.max_turns`
7. post-approval/pre-PR implementation -> `rework-required` /
   `awaiting-system-checks` / `handoff-ready`
   - once the worker opens a PR or completes the issue, existing handoff logic
     resumes unchanged

Explicit non-transition:

- `awaiting-human-handoff` must not consume the next run's prompt context after
  approval by collapsing back to a generic null PR state with no phase summary

## Failure-Class Matrix

| Observed condition                                                            | Local facts                                 | Normalized tracker facts                       | Expected decision                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Worker stopped at `plan-ready` and no human reply yet                         | prior attempt exists; no PR                 | latest signal is `plan-ready`                  | wait in `awaiting-human-handoff`; do not retry or rerun                                                             |
| Human approved after `plan-ready`; no PR exists yet                           | new run attempt scheduled or issue requeued | latest signal is `approved`; no PR             | rerun on same branch with turn 1 of a fresh run and prompt-visible "approved plan, continue implementation" context |
| Human waived after `plan-ready`; no PR exists yet                             | same as above                               | latest signal is `waived`; no PR               | same as approved: rerun implementation with fresh run budget and explicit resume context                            |
| Human requested changes after `plan-ready`; no PR exists yet                  | new run attempt scheduled                   | latest signal is `changes-requested`; no PR    | rerun to revise the plan, not generic implementation, with prompt-visible revision context                          |
| No PR exists and no valid plan-review handoff exists                          | ordinary fresh issue or malformed comments  | no relevant plan-review signal                 | use existing generic `missing-target` behavior                                                                      |
| Resumed implementation run still finishes with no PR after its new run budget | attempt turns exhausted again               | latest lifecycle still actionable pre-PR state | preserve existing failure/retry path, but with the new run actually having had the correct prompt context           |

## Storage / Persistence Contract

Do not introduce new durable files for this bug.

The system of record remains:

- GitHub issue comments for `plan-ready` and human review replies
- normalized tracker lifecycle facts derived from those comments
- existing issue artifacts/status snapshots for attempt and lifecycle
  observations

If extra state is needed, prefer a typed in-memory runtime seam over a new
workspace sentinel file. The desired behavior should be recoverable from the
tracker plus current code, not from local-only hidden state.

## Observability Requirements

- The resumed run should remain inspectable as a new attempt in status and
  issue artifacts.
- Tests should assert that the resumed attempt actually executes code work
  rather than silently recycling the old plan-only outcome.
- Prompt/context tests should make it obvious whether the worker sees:
  - generic missing-target with no plan context
  - approved-plan resume context
  - changes-requested revise-plan context

## Implementation Steps

1. Extend plan-review policy evaluation so approved/waived/changes-requested
   replies can produce a normalized actionable pre-PR lifecycle summary instead
   of always collapsing to `null` and then to the generic "No open pull
   request found" summary.
2. Refine the prompt-context contract so worker prompts can render lifecycle
   kind/summary for any normalized handoff state, while keeping PR-only facts
   separate from lifecycle facts that exist before a PR is opened.
3. Update orchestrator prompt plumbing so the initial prompt and continuation
   prompt both receive the normalized lifecycle context even when the lifecycle
   kind is `missing-target`.
4. Add unit coverage for:
   - plan-review policy after approved/waived/changes-requested replies
   - prompt rendering for pre-PR lifecycle context
   - orchestrator behavior that no longer drops `missing-target` lifecycle
     context on resumed runs
5. Add integration/e2e coverage that reproduces the `#289` path:
   - attempt 1 reaches `plan-ready`
   - a human approval is posted
   - a resumed attempt sees prompt-visible approved-plan context and can create
     implementation changes / a PR instead of failing immediately with inherited
     plan-only behavior

## Tests

- `pnpm exec vitest run tests/unit/plan-review-policy.test.ts`
- `pnpm exec vitest run tests/unit/workflow.test.ts`
- `pnpm exec vitest run tests/unit/orchestrator.test.ts`
- `pnpm exec vitest run tests/integration/github-bootstrap.test.ts`
- `pnpm exec vitest run tests/e2e/bootstrap-factory.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Acceptance Scenarios

1. Given a worker that has already posted `Plan status: plan-ready`, when a
   human replies `Plan review: approved`, then the next implementation run gets
   prompt-visible context that plan review is satisfied and starts with a fresh
   run turn budget.
2. Given the same setup with `Plan review: waived`, when the next run starts,
   then it also resumes implementation with fresh run-turn counting and without
   re-entering generic plan-only behavior.
3. Given `Plan review: changes-requested`, when the next run starts, then the
   prompt indicates that the plan must be revised rather than hiding that state
   behind a generic no-PR summary.
4. Given a fresh issue with no valid plan-review signals, when the worker runs,
   then existing generic `missing-target` behavior is unchanged.
5. Given the concrete `#289` repro path in an automated harness, when approval
   is posted after a plan-only first attempt, then the resumed attempt can make
   implementation progress instead of immediately terminating with the same
   plan-only max-turn failure mode.

## Exit Criteria

- approved or waived plan-review replies no longer disappear behind a generic
  null pre-PR prompt context
- a rerun after plan approval has explicit, trusted lifecycle context telling
  it to continue implementation on the existing branch
- regression tests reproduce and prevent the `#289` stuck-after-approval path
- no new tracker transport/prompt/orchestrator coupling is introduced beyond
  the normalized lifecycle seam

## Deferred

- explicit separate config knobs like `agent.plan_max_turns` and
  `agent.implementation_max_turns`
- richer lifecycle-specific operator surfaces for "approved plan, awaiting
  first implementation commit"
- any broader refactor of all prompt context sections beyond the lifecycle vs
  PR separation required for this fix

## Decision Notes

1. Prefer preserving the existing `missing-target` lifecycle kind with richer
   normalized summary/context over introducing a brand-new top-level lifecycle
   kind unless implementation proves that the current kind cannot represent the
   approved-plan resume seam cleanly.
2. Treat the bug as a prompt-visible lifecycle/context bug at the
   tracker-orchestrator boundary, not as a runner-session reuse bug. The fix
   should keep `agent.max_turns` per-run and make that fresh run budget usable
   by preserving the plan-review phase boundary into the next prompt.
