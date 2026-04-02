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
2. operator command environment wiring so descendant shells can see the active
   parent-loop marker
3. focused regression coverage for the observed nested-loop shape during a
   wake-up cycle
4. operator-facing guidance updates only if the checked-in prompt/skill/runbook
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
5. multi-machine or multi-operator coordination; this issue is about one local
   operator process tree during one wake-up cycle

## Current Gaps

Today the checked-in loop only protects startup with an instance-scoped local
lock under the current checkout's `.ralph/instances/<instance-key>/` state
root.

That leaves a gap during a live wake-up cycle:

1. the parent loop exports operator context to the spawned wake-up command, and
   descendant shells inherit that environment
2. if the wake-up command runs `pnpm operator` or `operator-loop.sh` from a
   different checkout or against a different selected instance, the child loop
   can use a different state root and avoid the parent's lock
3. the current implementation has no explicit "already inside an operator
   wake-up" guard, so the nested launch can create a second `operator-loop.sh`
   and a second child agent under the first loop's process tree
4. integration tests cover lock behavior and per-instance isolation, but they
   do not prove that a wake-up cycle cannot recursively start another
   operator loop underneath itself

## Decision Notes

1. Treat this as operator-loop coordination, not as a tracker or factory
   orchestration bug. The fix should stay at the repo-owned operator-loop
   boundary.
2. Prefer an inherited parent-loop marker over heuristics based on process-tree
   inspection. The marker is explicit, portable across descendant shells, and
   does not require `ps` parsing.
3. Fail closed at operator-loop startup with a clear error when a nested launch
   is detected. Silent best-effort behavior would keep the runtime hard to
   trust.
4. Keep the existing instance lock. The new nested-loop guard is an additional
   protection for descendant wake-up launches, not a replacement for stale-lock
   recovery or per-instance exclusivity.

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
2. minimal typed/config-resolved plumbing only if the guard needs it

Does not belong here:

1. process-tree inspection logic
2. tracker, workspace, or runner policy

### Coordination Layer

Belongs here:

1. the operator-loop outer state model for startup, nested-loop rejection, lock
   ownership, and one-cycle execution
2. the decision point that distinguishes a valid top-level launch from an
   inherited nested launch

Does not belong here:

1. factory dispatch, retry, reconciliation, or issue lifecycle transitions
2. using tracker state to guess whether a descendant shell is a nested
   operator-loop attempt

### Execution Layer

Belongs here:

1. shell export of the active parent-loop marker into the operator command
   environment
2. operator-loop startup checks that refuse the nested child process before a
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
2. regression tests that make the rejected nested-launch behavior inspectable

Does not belong here:

1. new dashboards or factory status-surface redesign
2. hiding nested-launch failures in logs without a testable signal

## Architecture Boundaries

### `skills/symphony-operator/operator-loop.sh`

Owns:

1. defining and exporting the inherited parent-loop marker
2. rejecting nested loop startup before the child can proceed into a wake-up
   cycle
3. preserving the current instance-lock behavior for true top-level launches

Does not own:

1. tracker lifecycle decisions
2. factory runtime restart/reconciliation policy
3. provider-specific runner semantics

### `tests/integration/operator-loop.test.ts`

Owns:

1. regression coverage for descendant nested launches during a live wake-up
   cycle
2. assertions that top-level behavior still works while nested launches fail
   closed

Does not own:

1. shell-only behavioral assumptions without stable assertions
2. tracker or orchestrator state-machine coverage unrelated to the operator
   loop

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
2. add focused integration coverage for the observed descendant-launch shape
3. update checked-in operator guidance only where it clarifies the enforced
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
   - startup detected an inherited active parent-loop marker and refused to
     continue
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
2. a rejected nested launch must not start a child wake-up cycle or child agent
3. a valid top-level launch still relies on the existing per-instance lock to
   prevent sibling loops in the same state root
4. the nested-launch guard is process-tree scoped, not the new durable source
   of truth for operator state

## Failure-Class Matrix

| Observed condition | Local facts available | Expected decision |
| --- | --- | --- |
| Top-level operator launch from repo root | no inherited parent-loop marker; normal config/instance metadata available | continue through startup, acquire the instance lock, and run normally |
| Descendant shell inside an active wake-up launches `pnpm operator` or `operator-loop.sh` | inherited parent-loop marker present in environment | fail immediately with a clear nested-launch error; do not acquire a second lock or start a second wake-up |
| Nested launch targets a different checkout or different selected workflow | inherited parent-loop marker present even though state-root/instance-key may differ | still fail closed because the child is inside an already-running wake-up process tree |
| Second top-level launch from another terminal for the same instance | no inherited parent-loop marker; same instance lock already owned by a live process | keep existing behavior: exit with the current "already running" lock message |
| Stale lock found for a valid top-level launch | no inherited parent-loop marker; lock owner not live | keep existing stale-lock recovery behavior |
| Operator command fails for non-nesting reasons | top-level launch succeeded; wake-up command exits non-zero | keep existing failed-cycle and retry behavior; this issue does not change ordinary cycle failure handling |

## Storage / Persistence Contract

Do not add new durable files for this fix.

The enforcement contract should be:

1. inherited environment markers for descendant shells during one active
   operator-loop process tree
2. existing instance-scoped lock files for top-level per-instance exclusivity
3. existing status/log artifacts for human inspection of failures

If metadata beyond a boolean marker is helpful for diagnostics, keep it in the
process environment or emitted status/log text rather than introducing a new
durable artifact.

## Observability Requirements

1. nested-launch rejection must emit a clear, grep-friendly error message
2. integration tests must prove the nested child loop never starts its own
   wake-up cycle when launched from inside a parent cycle
3. existing top-level loop status behavior should remain intact for non-nested
   runs

## Implementation Steps

1. Add the issue `#324` plan under
   `docs/plans/324-operator-loop-wake-up-nesting/plan.md`.
2. Update `skills/symphony-operator/operator-loop.sh` to define an explicit
   active parent-loop marker and reject nested descendant launches during
   startup.
3. Export the parent-loop marker into the operator command environment so
   descendant shells inherit it during a wake-up cycle.
4. Add integration coverage in `tests/integration/operator-loop.test.ts` for a
   nested descendant launch that currently slips past the per-instance lock.
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
3. integration: the nested-launch failure message is explicit enough to explain
   why the child was rejected
4. `pnpm lint`
5. `pnpm typecheck`
6. `pnpm test`

## Acceptance Scenarios

1. Given one active operator wake-up cycle, when a descendant shell tries to
   run `pnpm operator` or `operator-loop.sh`, then the child launch exits
   clearly and no second operator-loop process or child agent is started under
   the parent loop.
2. Given a separate top-level terminal launch for the same selected instance,
   when the first loop already owns the instance lock, then the existing
   "already running" behavior still applies.
3. Given an ordinary top-level operator run, when no nested-launch marker is
   present, then the loop behaves exactly as before.

## Exit Criteria

1. the operator loop has an explicit descendant-shell guard against nested
   operator-loop startup during a wake-up cycle
2. regression coverage proves the observed nested-launch shape is blocked
3. top-level operator-loop behavior and existing lock semantics remain intact
4. local QA passes
5. the branch/PR remains scoped to issue `#324`

## Deferred

1. broader operator supervision redesign
2. cross-host or multi-operator coordination
3. deeper process-introspection tooling for debugging arbitrary shell trees
4. factory-runtime changes unrelated to nested operator-loop prevention
