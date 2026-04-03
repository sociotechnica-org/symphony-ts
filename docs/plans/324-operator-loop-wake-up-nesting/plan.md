# Issue 324 Plan: Prevent Nested Operator Loops During Wake-Up Cycles

## Status

- plan-ready

## Goal

Ensure one wake-up loop owns one operator process tree for a selected
Symphony instance. A wake-up cycle must not be able to spawn a second
`operator-loop.sh` beneath the already-running loop, even if the child launch
comes from a descendant shell in another checkout or another instance path.

## Scope

This slice covers:

1. operator-loop coordination guards that detect an inherited active
   wake-up-cycle context and refuse nested loop startup
2. a selected-instance-owned active wake-up lease so same-instance nested
   launches are rejected even when the child starts from another checkout
3. operator command environment wiring so descendant shells can see the active
   parent-loop marker
4. focused regression coverage for the observed nested-loop shape during a
   wake-up cycle
5. operator-facing guidance updates only if the checked-in prompt/skill/runbook
   need an explicit "do not start another operator loop from inside a wake-up"
   rule

## Non-Goals

This slice does not include:

1. detached factory restart, watch, attach, or landing workflow changes
2. tracker transport, normalization, or lifecycle-policy refactors
3. runner transport changes for Codex, Claude, or generic-command outside the
   operator-loop wake-up guard
4. redesigning operator notebooks, release-state promotion, or resumable
   session storage beyond any small compatibility needed for the guard
5. broad multi-machine or multi-operator coordination; this issue stays focused
   on one selected instance during one local wake-up cycle

## Current Gaps

The first merged fix added an inherited parent-loop environment marker, but the
reopened regression on 2026-04-03 shows that marker alone is not sufficient.

Today the checked-in loop still protects startup primarily with an
instance-scoped local lock under the current checkout's
`.ralph/instances/<instance-key>/` state root.

That leaves a gap during a live wake-up cycle:

1. the parent loop exports operator context to the spawned wake-up command, and
   descendant shells inherit that environment
2. a real child launch can come from a different operator checkout or from a
   runner boundary that drops `SYMPHONY_OPERATOR_PARENT_*` variables before it
   starts the nested shell
3. when that happens, the child loop can use a different checkout-local state
   root, avoid the parent's `.ralph` lock, and start a second wake-up for the
   same selected instance
4. the current implementation has no selected-instance-owned active wake-up
   lease, so there is no cross-checkout same-instance fact that survives
   environment scrubbing
5. integration tests cover direct inherited-env nested launches, but they do
   not prove that a same-instance nested launch from another checkout is
   rejected when the child no longer sees the parent marker

## Decision Notes

1. Treat this as operator-loop coordination, not as a tracker or factory
   orchestration bug. The fix should stay at the repo-owned operator-loop
   boundary.
2. Keep the inherited parent-loop marker as the fast descendant-shell signal,
   but add a selected-instance-owned active wake-up lease so same-instance
   nested launches are still rejected when the child startup path scrubs the
   environment.
3. Store that lease under the selected instance root, not under one operator
   checkout's `.ralph` tree. Same-instance coordination is instance-owned
   runtime correctness, not operator-notebook state.
4. Fail closed at operator-loop startup with a clear error when a nested launch
   is detected. Silent best-effort behavior would keep the runtime hard to
   trust.
5. Keep the existing checkout-local instance lock. The new active wake-up lease
   is an additional protection for cross-checkout same-instance launches, not a
   replacement for stale-lock recovery or per-checkout exclusivity.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses
`docs/architecture.md`.

### Policy Layer

Belongs here:

1. the repo-owned rule that one active wake-up loop must not launch another
   operator loop from inside its own wake-up cycle
2. the rule that nested wake-up launches fail clearly instead of continuing
   with duplicate operator ownership

Does not belong here:

1. tracker-specific review or landing policy
2. ad hoc shell folklore about which commands the operator "probably should not
   run" without an enforced contract

### Configuration Layer

Belongs here:

1. any explicit environment-marker contract that identifies an active
   parent operator loop for descendant shells
2. minimal typed path derivation for a selected-instance-owned active wake-up
   lease under the instance root

Does not belong here:

1. process-tree inspection logic
2. tracker, workspace, or runner policy

### Coordination Layer

Belongs here:

1. the operator-loop outer state model for startup, nested-loop rejection, lock
   ownership, and one-cycle execution
2. the decision point that distinguishes a valid top-level launch from an
   inherited nested launch or a same-instance active wake-up already owned by
   another loop

Does not belong here:

1. factory dispatch, retry, reconciliation, or issue lifecycle transitions
2. using tracker state to guess whether a descendant shell is a nested
   operator-loop attempt

### Execution Layer

Belongs here:

1. shell export of the active parent-loop marker into the operator command
   environment
2. operator-loop acquisition and release of the selected-instance active
   wake-up lease around a live wake-up cycle
3. operator-loop startup checks that refuse the nested child process before a
   second wake-up cycle begins

Does not belong here:

1. Codex- or Claude-specific runner rewrites
2. workspace lifecycle changes

### Integration Layer

Belongs here:

1. none beyond the operator shell boundary and any runner-neutral environment
   contract needed by descendant shells

Does not belong here:

1. GitHub issue or PR state inspection
2. tracker transport/normalization changes

### Observability Layer

Belongs here:

1. clear stderr/status evidence when a nested loop launch is rejected
2. regression tests that make both inherited-env and env-scrubbed same-instance
   nested-launch rejections inspectable

Does not belong here:

1. new dashboards or factory status-surface redesign
2. hiding nested-launch failures in logs without a testable signal

## Architecture Boundaries

### `skills/symphony-operator/operator-loop.sh`

Owns:

1. defining and exporting the inherited parent-loop marker
2. acquiring and releasing the selected-instance active wake-up lease around a
   live wake-up cycle
3. rejecting nested loop startup before the child can proceed into a wake-up
   cycle
4. preserving the current instance-lock behavior for true top-level launches

Does not own:

1. tracker lifecycle decisions
2. factory runtime restart/reconciliation policy
3. provider-specific runner semantics

### `tests/integration/operator-loop.test.ts`

Owns:

1. regression coverage for descendant nested launches during a live wake-up
   cycle
2. regression coverage for same-instance nested launches that come from another
   checkout after the child startup path drops inherited parent-loop markers
3. assertions that top-level behavior still works while nested launches fail
   closed

Does not own:

1. shell-only behavioral assumptions without stable assertions
2. tracker or orchestrator state-machine coverage unrelated to the operator
   loop

### `src/domain/instance-identity.ts`

Owns:

1. typed derivation of the selected-instance coordination path for the active
   wake-up lease

Does not own:

1. shell lock-acquisition behavior
2. tracker or orchestrator policy

### `skills/symphony-operator/SKILL.md`, `skills/symphony-operator/operator-prompt.md`, and operator docs

Owns:

1. the operator-facing rule that a wake-up cycle must not start another
   operator loop
2. guidance to use factory-control commands instead of nesting the loop when
   deeper inspection is needed

Does not own:

1. the only enforcement mechanism
2. hidden recovery logic that exists only in prose

## Slice Strategy And PR Seam

Keep this as one reviewable PR focused on nested operator-loop prevention:

1. add an explicit parent-loop marker and nested-launch rejection path in the
   operator loop
2. add one selected-instance-owned active wake-up lease so same-instance nested
   launches are rejected even when the child starts from another checkout
3. add focused integration coverage for the observed descendant-launch shape,
   including the env-scrubbed cross-checkout regression
4. update checked-in operator guidance only where it clarifies the enforced
   contract

Deferred from this PR:

1. broader operator-loop refactors
2. detached runtime/process-tree diagnostics beyond what is required to prove
   the guard
3. any cross-instance scheduling policy or multi-host operator coordination

Why this seam is reviewable:

1. it stays inside the repo-owned operator loop and its tests
2. it does not mix tracker/orchestrator/runtime-control refactors into the same
   patch
3. it directly addresses the observed trust issue with one explicit contract:
   no nested wake-up loops inside a live wake-up cycle

## Operator Loop Runtime State Model

This issue changes operator-loop coordination behavior, so the local runtime
state must stay explicit.

### States

1. `idle`
   - no loop process is starting or running
2. `startup-validating`
   - a new loop process is resolving config, instance metadata, and nested-loop
     eligibility
3. `rejected-nested-launch`
   - startup detected either an inherited active parent-loop marker or a live
     same-instance active wake-up lease and refused to continue
4. `acquiring-lock`
   - startup is taking the instance-scoped local lock for a valid top-level
     launch
5. `sleeping`
   - the loop is healthy and waiting for the next wake-up
6. `acting`
   - one wake-up cycle is running the operator command
7. `recording`
   - post-cycle status/log/session bookkeeping is being written
8. `retrying`
   - the prior cycle failed and the loop is waiting before the next attempt
9. `stopping`
   - the loop is shutting down cleanly

### Allowed transitions

1. `idle -> startup-validating`
2. `startup-validating -> rejected-nested-launch`
3. `startup-validating -> acquiring-lock`
4. `acquiring-lock -> sleeping`
5. `acquiring-lock -> retrying` only via startup failure that still leaves the
   top-level loop alive
6. `sleeping -> acting`
7. `acting -> recording`
8. `recording -> sleeping`
9. `acting -> retrying`
10. `retrying -> acting`
11. `sleeping -> stopping`
12. `acting -> stopping`
13. `recording -> stopping`
14. `retrying -> stopping`
15. `stopping -> idle`

### Contract rules

1. an inherited parent-loop marker is authoritative for descendant-shell nested
   launches and must be checked before lock acquisition
2. a selected-instance active wake-up lease is authoritative for same-instance
   nested launches when the child no longer sees the inherited marker
3. a rejected nested launch must not start a child wake-up cycle or child agent
4. a valid top-level launch still relies on the existing per-instance lock to
   prevent sibling loops in the same checkout-local state root
5. the active wake-up lease is runtime coordination, not a new notebook or
   tracker artifact

## Failure-Class Matrix

| Observed condition                                                                            | Local facts available                                                                                                  | Expected decision                                                                                         |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Top-level operator launch from repo root                                                      | no inherited parent-loop marker; no live same-instance active wake-up lease; normal config/instance metadata available | continue through startup, acquire the checkout-local instance lock, and run normally                      |
| Descendant shell inside an active wake-up launches `pnpm operator` or `operator-loop.sh`      | inherited parent-loop marker present in environment                                                                    | fail immediately with a clear nested-launch error; do not acquire a second lock or start a second wake-up |
| Same-instance nested launch starts from another checkout after parent-loop variables scrubbed | no parent marker; selected-instance active wake-up lease exists with a live owner pid                                  | fail immediately with a clear nested-launch error; do not start a second wake-up or child agent           |
| Same-instance nested launch sees a stale active wake-up lease                                 | no parent marker; selected-instance active wake-up lease exists but owner pid is dead                                  | clear the stale lease and continue as a valid top-level launch                                            |
| Nested launch targets a different selected workflow                                           | inherited parent-loop marker present even though selected instance differs                                             | still fail closed because the child is inside an already-running wake-up process tree                     |
| Second top-level launch from another terminal for the same instance in the same checkout      | no inherited parent-loop marker; checkout-local instance lock already owned by a live process                          | keep existing behavior: exit with the current "already running" lock message                              |
| Stale checkout-local instance lock found for a valid top-level launch                         | no inherited parent-loop marker; checkout-local lock owner not live                                                    | keep existing stale-lock recovery behavior                                                                |
| Operator command fails for non-nesting reasons                                                | top-level launch succeeded; wake-up command exits non-zero                                                             | keep existing failed-cycle and retry behavior; this issue does not change ordinary cycle failure handling |

## Storage / Persistence Contract

Add one small selected-instance-owned coordination artifact for active wake-up
ownership:

1. `<selected-instance-root>/.var/factory/operator/active-wake-up.lock/`
2. owner metadata inside that lock directory with at least the owning pid,
   selected instance root, and operator repo root for diagnostics

The full enforcement contract should be:

1. inherited environment markers for descendant shells during one active
   operator-loop process tree
2. the selected-instance active wake-up lease for same-instance cross-checkout
   nested-launch rejection
3. existing checkout-local instance lock files for top-level per-checkout
   exclusivity
4. existing status/log artifacts for human inspection of failures

## Observability Requirements

1. nested-launch rejection must emit a clear, grep-friendly error message
2. integration tests must prove the nested child loop never starts its own
   wake-up cycle when launched from inside a parent cycle, including when the
   child launch comes from another checkout and the inherited marker was scrubbed
3. existing top-level loop status behavior should remain intact for non-nested
   runs

## Implementation Steps

1. Add the issue `#324` plan under
   `docs/plans/324-operator-loop-wake-up-nesting/plan.md`.
2. Extend the selected-instance path contract so the operator loop can derive a
   canonical active wake-up lease location under the instance root.
3. Update `skills/symphony-operator/operator-loop.sh` to:
   - keep the explicit active parent-loop marker,
   - reject nested descendant launches during startup,
   - acquire and release the selected-instance active wake-up lease around each
     live wake-up cycle,
   - and clear stale active wake-up leases when their owner pid is dead.
4. Add focused coverage:
   - unit coverage for the new selected-instance coordination path helper
   - integration coverage for a nested descendant launch from another checkout
     that scrubs inherited parent-loop markers
5. Update operator prompt/skill/runbook wording only if needed to match the
   enforced guard and direct operators back to supported factory-control
   commands.
6. Run formatting/lint/typecheck/test gates for the touched surfaces.
7. Run a local self-review pass, fix findings, then open/update the PR for
   `#324`.

## Tests

1. integration: a top-level `operator-loop.sh --once` run still succeeds for a
   normal workflow
2. integration: a wake-up command that tries to launch a nested operator loop
   from inside the parent cycle fails closed before the child starts a second
   wake-up
3. integration: the same-instance nested launch still fails closed when it
   comes from another checkout and the child startup path scrubs inherited
   parent-loop markers
4. integration: the nested-launch failure message is explicit enough to explain
   why the child was rejected
5. unit: selected-instance coordination paths derive under
   `<selected-instance-root>/.var/factory/operator/`
6. `pnpm lint`
7. `pnpm typecheck`
8. `pnpm test`

## Acceptance Scenarios

1. Given one active operator wake-up cycle, when a descendant shell tries to
   run `pnpm operator` or `operator-loop.sh`, then the child launch exits
   clearly and no second operator-loop process or child agent is started under
   the parent loop.
2. Given one active operator wake-up cycle, when a nested child launch starts
   from another checkout for the same selected workflow and the child no longer
   sees the inherited parent marker, then the selected-instance active wake-up
   lease still rejects the child before it can start a second wake-up.
3. Given a separate top-level terminal launch for the same selected instance in
   the same checkout, when the first loop already owns the checkout-local
   instance lock, then the existing "already running" behavior still applies.
4. Given an ordinary top-level operator run, when no nested-launch marker or
   live active wake-up lease is present, then the loop behaves exactly as
   before.

## Exit Criteria

1. the operator loop has an explicit descendant-shell guard against nested
   operator-loop startup during a wake-up cycle
2. the operator loop also has a selected-instance active wake-up lease that
   blocks same-instance nested launches across checkouts
3. regression coverage proves the observed nested-launch shape is blocked
4. top-level operator-loop behavior and existing lock semantics remain intact
5. local QA passes
6. the branch/PR remains scoped to issue `#324`

## Deferred

1. broader operator supervision redesign
2. cross-host or multi-operator coordination
3. deeper process-introspection tooling for debugging arbitrary shell trees
4. factory-runtime changes unrelated to nested operator-loop prevention
