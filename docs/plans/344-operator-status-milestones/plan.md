# Issue 344 Plan: Operator Status Milestone Progress During Wake-Up Cycles

## Status

- plan-ready

## Goal

Make long operator wake-up cycles visibly progressive from the outside so
`status.json` and `status.md` no longer sit at one coarse `acting` state for
the full duration of a long `codex` turn.

The intended outcome of this slice is:

1. the operator status surface exposes the current wake-up milestone and the
   last time progress advanced during an active cycle
2. progress updates happen as the wake-up crosses major checkpoints such as
   report review, plan review, landing, post-landing verification, and
   post-merge refresh
3. operators can distinguish "still progressing" from "still active but has
   not emitted a new milestone recently" without reading the raw cycle log
4. the implementation stays within the current operator-loop seam instead of
   turning this issue into the broader typed-runtime rewrite tracked elsewhere

## Scope

This slice covers:

1. an additive operator-progress contract inside the existing operator status
   artifacts
2. a focused helper path the in-cycle operator command can call to publish
   milestone updates while the shell is blocked inside the long-running wake-up
   turn
3. operator-loop wiring that initializes, preserves, and finalizes the progress
   section of the status artifacts
4. checked-in operator prompt and guidance updates that require progress
   publishing at major wake-up checkpoints
5. focused unit and integration coverage, including a long-cycle regression
   that inspects status mid-cycle instead of only after the command exits

## Non-Goals

This slice does not include:

1. moving the operator loop out of shell into a fully typed runtime service
2. redesigning `control-state.json` or changing its checkpoint-order semantics
3. replacing the wake-up log with a streaming journal
4. introducing tracker or GitHub transport changes
5. adding automated failure or watchdog policy that terminates a cycle solely
   because milestone updates stop advancing

## Current Gaps

1. `skills/symphony-operator/operator-loop.sh` writes `status.json` and
   `status.md` before the wake-up command starts and again only after it ends,
   so long healthy cycles look identical to hangs
2. the shell cannot observe semantic progress inside the active operator
   command, so shell-only checkpoint writes are not enough for this issue
3. the checked-in prompt requires wake-up-log updates only at the end of the
   cycle, which leaves no in-cycle breadcrumb surface
4. there is no machine-readable "current milestone" or "last progress at"
   field in the operator status contract
5. existing operator-loop integration tests mostly assert end-of-cycle status
   and do not prove that live progress is visible while the wake-up command is
   still running

## Decision Notes

1. Keep deterministic checkpoint ordering in `control-state.json`, but do not
   overload that artifact into the live progress surface. `control-state.json`
   is the pre-cycle checkpoint decision contract; the missing piece here is
   in-cycle progress visibility.
2. Prefer additive fields in the existing `status.json` and `status.md`
   artifacts over inventing a second status sidecar. Operators already read
   these files, so the first slice should improve the canonical surface rather
   than scatter state.
3. Use a small checked-in helper for progress publication rather than asking
   the prompt to rewrite JSON and markdown directly. The helper keeps the
   contract typed, reduces prompt drift, and avoids hand-built shell/JSON edits
   during long cycles.
4. Keep this issue at the operator status seam. Do not combine it with the
   broader operator-architecture migration or prompt-policy redesign.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses
`docs/architecture.md`.

### Policy Layer

Belongs here:

1. the repo-owned rule that long wake-up cycles must expose milestone progress
   through the operator status surface
2. the rule that operator progress should be visible from routine status reads,
   not only from raw logs
3. the rule that checkpoint progress must remain inspectable without changing
   tracker semantics

Does not belong here:

1. GitHub-specific landing or review transport logic
2. implicit prompt-only expectations with no code-owned contract

### Configuration Layer

Belongs here:

1. the environment contract that gives the active operator command access to
   the checked-in progress updater and status artifact paths
2. any typed status-schema additions needed to keep the progress surface stable

Does not belong here:

1. checkpoint decision logic
2. ad hoc milestone names embedded only in shell snippets

### Coordination Layer

Belongs here:

1. the normalized milestone vocabulary for one wake-up cycle
2. the allowed progress transitions across the current wake-up checkpoints
3. the distinction between coarse loop state (`acting`, `recording`, `idle`,
   `failed`) and in-cycle milestone progress

Does not belong here:

1. tracker transport changes
2. long prompt prose as the only definition of milestone sequencing

### Execution Layer

Belongs here:

1. operator-loop initialization and finalization of the progress snapshot
2. in-cycle helper execution from the active operator command to publish new
   milestones while the shell is blocked in the command
3. prompt instructions telling the operator when to emit a milestone update

Does not belong here:

1. provider-specific runner rewrites
2. shell-only JSON mutation without a typed helper

### Integration Layer

Belongs here:

1. local artifact reads and writes needed to refresh the canonical operator
   status files safely
2. reuse of existing operator-local artifacts such as `control-state.json` and
   release/report-review evidence when composing milestone summaries

Does not belong here:

1. new GitHub API flows
2. mixing tracker transport, normalization, and operator progress policy in
   one patch

### Observability Layer

Belongs here:

1. the additive progress block in `status.json`
2. the corresponding human-readable milestone section in `status.md`
3. timestamps and summaries that make stalled-looking cycles distinguishable
   from actively progressing cycles
4. tests and docs for the user-visible status contract

Does not belong here:

1. silently burying progress only in cycle logs
2. a second competing status source with different semantics

## Architecture Boundaries

### New focused operator-progress helper/module

Owns:

1. the typed progress payload for the current wake-up cycle
2. validation and atomic writes for additive status updates
3. rendering the progress fields into both `status.json` and `status.md`

Does not own:

1. checkpoint ordering decisions
2. tracker reads or GitHub mutations
3. wake-up-log persistence

### `skills/symphony-operator/operator-loop.sh`

Owns:

1. initializing progress at cycle start
2. preserving progress while the operator command is active
3. finalizing progress on success or failure
4. exporting the progress updater contract to the operator command

Does not own:

1. hand-built parsing or rendering of milestone payloads beyond passing through
   the typed helper
2. the only definition of milestone names and summaries

### `skills/symphony-operator/operator-prompt.md` and `SKILL.md`

Owns:

1. telling the operator to emit milestone updates at major checkpoints
2. naming the required moments that deserve progress publication, including
   immediately after `/land` and during post-landing work

Does not own:

1. direct editing of status JSON/markdown
2. the only machine-readable definition of the progress schema

### Operator docs

Owns:

1. describing how to interpret the new progress fields in routine monitoring
2. clarifying that `control-state.json` is checkpoint ordering while
   `status.json` / `status.md` show live in-cycle progress

Does not own:

1. the implementation details of the progress updater
2. prompt-only behavior without code support

## Slice Strategy And PR Seam

Keep this as one reviewable PR focused on one narrow seam: the operator's live
status contract during a single wake-up cycle.

This stays reviewable because it limits the work to:

1. one focused operator-progress helper and additive status schema update
2. targeted `operator-loop.sh` wiring
3. prompt/skill/docs updates that use the new helper
4. unit and integration coverage for mid-cycle status visibility

Deferred from this PR:

1. stale-progress watchdog policy that automatically escalates or fails a cycle
2. append-only in-cycle wake-up-log breadcrumbs
3. broader shell-to-TypeScript operator runtime migration
4. any automation that turns operator progress milestones into tracker writes

## Runtime State Model

The progress surface should model one wake-up cycle with two related but
distinct axes:

1. coarse loop state
2. in-cycle progress milestone

### Coarse loop state

- `sleeping`
- `acting`
- `recording`
- `idle`
- `retrying`
- `failed`
- `stopping`

### In-cycle milestone state

- `cycle-start`
- `checkpoint-runtime`
- `checkpoint-report-review`
- `checkpoint-release`
- `checkpoint-actions`
- `landing-issued`
- `post-landing-follow-through`
- `post-merge-refresh`
- `wake-up-log`
- `cycle-finished`
- `cycle-failed`

### Allowed transitions

1. a wake-up enters `acting` with `cycle-start`
2. while `acting`, milestone updates may advance forward through the checkpoint
   sequence and may repeat when the operator handles several items in one
   checkpoint family
3. after `/land`, the cycle may move from `landing-issued` to
   `post-landing-follow-through` and then to `post-merge-refresh`
4. successful completion moves to `recording` and then `idle` with
   `cycle-finished`
5. failures move to `failed` with `cycle-failed`

The progress contract should keep the current milestone summary, its timestamp,
and an optional sequence number so readers can tell whether new progress has
been published during the active cycle.

## Failure-Class Matrix

| Observed condition                                                            | Local facts available                                          | Expected decision                                                                                                                       |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Active cycle started but no in-cycle milestone has been emitted yet           | coarse state is `acting`; progress milestone is `cycle-start`  | show active cycle start with the initial timestamp; do not infer a hang yet                                                             |
| Operator command emits a new milestone successfully                           | updater receives a valid milestone payload                     | atomically update `status.json` and `status.md` so both surfaces reflect the new checkpoint                                             |
| Operator command keeps running but milestone timestamp stops advancing        | coarse state remains `acting`; last milestone timestamp is old | preserve the last known milestone and timestamp so operators can see "active, no new progress since ..." without auto-failing the cycle |
| Progress update payload is malformed                                          | helper rejects invalid milestone input                         | leave the last valid progress entry intact and fail the helper call clearly so the prompt/tooling can be corrected                      |
| Operator command exits successfully without any mid-cycle update beyond start | coarse state transitions to `recording` then `idle`            | still show final completion state; tests should cover that the surface remains valid even if the command emitted no extra milestones    |
| Operator command exits with failure after partial progress                    | last valid milestone exists; exit code is non-zero             | preserve the last valid milestone, mark the cycle as `failed`, and attach a terminal failure milestone/summary                          |

## Storage Contract

Use the existing operator status artifacts as the canonical storage surface.

Planned contract:

1. add an additive `progress` object to `status.json`
2. render the same facts in a dedicated progress section inside `status.md`
3. keep writes atomic so observers never see mismatched partial JSON/markdown
4. avoid a separate durable store unless the implementation proves the
   existing status files cannot support safe additive updates

The `progress` object should minimally include:

1. current milestone id
2. human-readable summary
3. last-updated timestamp
4. sequence number or monotonic counter for the current cycle
5. optional checkpoint family or related issue/PR identifiers when relevant

## Observability Requirements

1. `status.json` must expose enough machine-readable data for tooling to tell
   which milestone the active wake-up last reached and when it last advanced
2. `status.md` must surface the same information in a compact operator-facing
   form
3. the surface must make `/land` visible as a milestone distinct from later
   post-landing follow-through
4. the new fields must be additive and backward-compatible for existing status
   readers that ignore unknown keys
5. the status contract must remain understandable without reading the raw
   operator cycle log

## Implementation Steps

1. Add a focused operator-progress helper under `src/observability/` plus a
   small checked-in entry point the operator command can call.
2. Extend the operator status contract and renderer so `status.json` and
   `status.md` carry additive live-progress fields.
3. Update `skills/symphony-operator/operator-loop.sh` to:
   - initialize the progress block at cycle start
   - export the updater path/contract to the active operator command
   - finalize progress on success or failure without clobbering the last valid
     in-cycle milestone
4. Update `skills/symphony-operator/operator-prompt.md` and
   `skills/symphony-operator/SKILL.md` so the operator emits milestone updates
   at each major checkpoint and immediately after `/land`.
5. Update operator docs where needed so the new live-progress fields and their
   relationship to `control-state.json` are explicit.
6. Add focused unit tests for the progress contract and integration coverage
   for a long-running fake operator command that updates milestones while the
   loop is still active.

## Tests

1. unit: progress payload validation and status rendering helpers
2. integration: operator loop publishes initial progress at cycle start
3. integration: a long-running fake operator command updates progress
   mid-cycle and the test can read the updated milestone before the command
   exits
4. integration: final success preserves the last meaningful milestone and then
   publishes completion
5. integration: failure after partial progress surfaces `cycle-failed` without
   losing the earlier milestone context
6. regression: existing operator-loop status assertions stay valid aside from
   the additive fields

## Acceptance Scenarios

1. Given a long wake-up handling completed-run report review, when the operator
   moves from checkpoint selection into report work, then `status.json` and
   `status.md` show a report-review milestone before the cycle ends.
2. Given a wake-up that posts `/land`, when the operator issues the command and
   continues into post-landing work, then the status surface shows
   `landing-issued` and later `post-landing-follow-through` instead of staying
   at one generic `acting` state.
3. Given a wake-up that reaches post-merge refresh, when the operator is
   checking runtime freshness and restart needs, then the status surface shows
   that milestone with a fresh timestamp.
4. Given a still-running wake-up whose last milestone is several minutes old,
   when an operator reads `status.json` or `status.md`, then they can see the
   last known milestone and its timestamp instead of mistaking the cycle for a
   silently hung process.

## Exit Criteria

1. long operator cycles expose milestone progress through the checked-in status
   artifacts during the cycle, not only before and after it
2. `/land` and post-landing follow-through are distinguishable milestones
3. the prompt and skill rely on the checked-in helper instead of ad hoc status
   rewrites
4. unit and integration tests cover mid-cycle progress visibility
5. docs explain how to interpret the new fields and how they differ from
   `control-state.json`

## Deferred To Later Issues Or PRs

1. automatic stale-progress classification or watchdog escalation
2. streaming wake-up-log breadcrumbs during the cycle
3. broader typed-runtime replacement of the shell operator loop
4. richer milestone taxonomies if future operator work needs more granularity
