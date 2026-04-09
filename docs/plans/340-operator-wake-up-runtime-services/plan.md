# Issue 340 Plan: Operator Wake-Up Runtime Services

## Status

- plan-ready

## Goal

Move the deterministic operator wake-up control path out of
`skills/symphony-operator/operator-loop.sh` and into typed runtime services so
the shell becomes a thin bootstrap wrapper instead of the primary control
plane.

The intended outcome of this slice is:

1. one typed operator runtime service owns wake-up cycle orchestration,
   lock/lease handling, status transitions, and operator-command execution
2. the checked-in shell script shrinks to minimal bootstrap and invocation
   duties
3. the existing operator prompt, runbook, and repo-owned policy remain
   consumers of typed state instead of re-owning deterministic sequencing
4. issue `#330` can keep moving repo-specific operator policy into
   `OPERATOR.md` without layering that work on top of a monolithic shell
   harness

## Scope

This slice covers:

1. a typed operator runtime entrypoint that resolves config and selected
   instance context, ensures the operator state root exists, and runs one
   wake-up cycle or continuous wake-up loop
2. typed coordination services for the operator loop lock and active wake-up
   lease, including stale-owner recovery and nested-launch rejection
3. typed cycle orchestration for:
   - pre-cycle release-state refresh and ready promotion
   - session preparation and recording
   - control-state refresh
   - status/progress transitions
   - operator command execution and environment shaping
   - post-cycle refresh and recording
4. a compatibility-preserving shell wrapper that delegates to the typed
   runtime entrypoint
5. focused unit and integration coverage that proves the shell is no longer
   the owner of operator control behavior

## Non-Goals

This slice does not include:

1. removing prompts or the operator notebook surfaces
2. redesigning `control-state.json`, `release-state.json`, or plan-review
   semantics
3. changing tracker transport, tracker normalization, or tracker lifecycle
   policy
4. moving repo-specific operator policy out of `OPERATOR.md`-adjacent docs and
   prompts into code
5. expanding into the live milestone-progress bug tracked by `#344` beyond any
   wiring required to keep the existing progress contract working
6. redesigning the detached factory-control surface or the factory runtime
   restart policy

## Current Gaps

1. `skills/symphony-operator/operator-loop.sh` still owns the operator loop
   state machine even though config resolution, session reuse, control-state
   refresh, release-state evaluation, and status/progress rendering already
   live in TypeScript helpers
2. shell branches still own lock/lease acquisition, stale-owner cleanup,
   runtime path setup, status JSON assembly, environment shaping, and the
   sequencing around operator command execution
3. integration coverage is anchored on invoking the shell script directly, so
   the current tests prove behavior but do not establish a typed operator
   runtime contract
4. repo-owned operator policy work in `#330` risks depending on a shared shell
   harness that still mixes deterministic mechanics, prompt wiring, and local
   bootstrap concerns
5. the current shell file is large enough that small changes to wake-up
   correctness, recovery, or observability tend to touch several unrelated
   branches at once

## Decision Notes

1. Keep the artifact paths and user-facing commands stable in this slice.
   `pnpm operator`, `pnpm operator:once`, `.ralph/instances/<instance-key>/`,
   and the operator prompt environment contract should continue to work.
2. Introduce typed operator-specific runtime services rather than pushing this
   logic into `src/orchestrator/`. The factory orchestrator and the operator
   wake-up harness are adjacent coordination systems but not the same control
   plane.
3. Preserve existing typed helpers where they already express stable seams.
   This slice should compose `resolveOperatorLoopConfig`,
   `prepareOperatorCycle`, `recordOperatorCycle`,
   `refreshOperatorControlState`, `writeOperatorStatusSnapshot`, and
   `updateOperatorStatusProgress` rather than re-embedding their logic.
4. Keep the first PR centered on control behavior, not on repo-owned policy
   content. The operator prompt may need small wording updates to reflect the
   new runtime entrypoint, but policy ownership stays with the selected
   repository and issue `#330`.
5. Prefer compatibility-preserving state-file migration. The first slice
   should keep current file locations and should read stale pre-refactor
   lock/lease ownership artifacts well enough to recover from them safely.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in
[`docs/architecture.md`](../../architecture.md).

### Policy Layer

Belongs here:

1. the rule that deterministic operator wake-up control belongs in typed code
   and tests rather than shell branches and prompt luck
2. the rule that repo-owned operator policy stays repo-owned and should remain
   distinct from shared wake-up mechanics
3. the rule that the shell wrapper is bootstrap only, not the durable owner of
   control-plane state

Does not belong here:

1. tracker-specific API behavior
2. shell-specific parsing details

### Configuration Layer

Belongs here:

1. typed resolution of operator CLI/env inputs
2. typed derivation of selected-instance paths and runtime environment values
3. the bootstrap contract between the shell wrapper and the typed runtime
   entrypoint

Does not belong here:

1. wake-up checkpoint policy evaluation
2. tracker reads or release-state decisions

### Coordination Layer

Belongs here:

1. the operator runtime state machine for one wake-up loop
2. loop-lock and active-wake-up-lease transitions
3. sequencing for pre-cycle refresh, command execution, post-cycle refresh,
   retry sleep, and graceful stop

Does not belong here:

1. tracker transport or parsing
2. repo-specific operator policy text

### Execution Layer

Belongs here:

1. preparing the operator command, executing it, and recording session state
2. shaping the prompt environment contract for the active wake-up command
3. delegating from the shell wrapper into the typed runtime entrypoint

Does not belong here:

1. direct tracker mutation policy
2. hand-built shell status serialization

### Integration Layer

Belongs here:

1. reading and writing existing operator-local artifacts and status files
2. calling the existing release-state, ready-promotion, and control-state
   helpers through stable interfaces
3. compatibility reads for stale lock/lease artifacts left by the pre-refactor
   shell loop

Does not belong here:

1. new GitHub transport logic
2. mixing tracker transport, normalization, and operator runtime policy in one
   module

### Observability Layer

Belongs here:

1. preserving the current `status.json`, `status.md`, `control-state.json`,
   log-file, and progress surfaces
2. exposing runtime state transitions and cycle outcomes through typed status
   writes
3. tests and docs that make the typed-runtime seam inspectable

Does not belong here:

1. burying control decisions only in shell stderr
2. forcing operators to infer state transitions from prompt prose

## Architecture Boundaries

### New `src/operator/` runtime services

Own:

1. operator loop and wake-up cycle coordination
2. typed loop-lock and active-lease services
3. operator runtime context and command-environment assembly
4. orchestration of existing session, control-state, release-state, and status
   helpers

Do not own:

1. tracker transport
2. repo-specific operator policy
3. factory orchestrator retry or dispatch policy

### Existing typed helpers under `src/config/`, `src/runner/`, and `src/observability/`

Own:

1. config parsing and provider-command description
2. session preparation and recording
3. control-state evaluation
4. release-state and ready-promotion artifacts
5. status/progress rendering

Do not own:

1. the top-level operator loop state machine
2. shell bootstrap concerns

### `skills/symphony-operator/operator-loop.sh`

Own:

1. locating the repository root and checked-in prompt file
2. launching the typed runtime entrypoint with the current shell-facing CLI
   contract

Do not own:

1. lock or lease semantics
2. status JSON construction
3. cycle orchestration
4. provider-command/session control logic

### Operator prompt and docs

Own:

1. telling the operator how to consume typed state and progress surfaces
2. repo-owned judgment and escalation rules

Do not own:

1. the only definition of wake-up sequencing
2. shell-dependent recovery behavior

## Layering Notes

- `tracker`
  - remains unchanged in this slice except for existing helper calls through
    stable interfaces
  - must not absorb operator lock/lease or loop-state concerns
- `workspace`
  - remains unchanged
  - must not become the owner of operator notebook bootstrap or state-root
    setup
- `runner`
  - continues to own provider/session mechanics only
  - must not become the owner of loop locks, release checkpoints, or status
    sequencing
- `orchestrator`
  - remains unchanged
  - must not become the home for repo-owned operator wake-up control

## Slice Strategy And PR Seam

Land this as one reviewable PR focused on one seam: replace the shell-owned
operator control state machine with typed runtime services while preserving the
public operator-loop command surface and artifact contract.

What lands in this PR:

1. one typed operator runtime entrypoint and focused services under
   `src/operator/`
2. shell-to-TypeScript delegation so `operator-loop.sh` becomes a thin wrapper
3. unit tests for the new loop-state, lease, and cycle orchestration services
4. focused integration tests proving the shell wrapper still works while the
   typed runtime owns the behavior
5. small doc updates that describe the new boundary

What is deliberately deferred:

1. repo-owned operator policy work in `#330`
2. broader status-progress improvements in `#344`
3. any tracker, orchestrator, or detached-runtime redesign beyond what this
   seam requires

This PR is reviewable because it keeps one architectural question in scope:
does operator wake-up control now live in typed services with a thin shell
wrapper? It does not combine tracker changes, repo-policy migration, or
factory-runtime redesign.

## Runtime State Model

### Loop State Machine

The typed runtime should model these states explicitly:

1. `bootstrapping`
   - resolve operator config, selected instance identity, prompt path, and
     operator state paths
2. `acquiring-loop-lock`
   - acquire or recover the long-lived top-level loop lock
3. `sleeping`
   - continuous mode idle wait before the next wake-up
4. `preparing-cycle`
   - refresh release state and ready promotion, prepare session, refresh
     control state, initialize status/progress, and open the cycle log
5. `acquiring-active-lease`
   - acquire or recover the in-cycle active wake-up lease for the selected
     instance
6. `running-command`
   - execute the operator command with the prompt and typed environment
7. `post-cycle-refresh`
   - release the active lease, refresh release/control status, and compute the
     cycle outcome
8. `recording-success`
   - record a successful cycle, finalize status, and settle briefly before the
     next state
9. `recording-failure`
   - record a failed cycle, finalize status, and choose retry or exit
10. `retrying`
    - continuous mode sleep after a failed cycle
11. `stopping`
    - signal-driven shutdown path that releases held coordination artifacts and
      writes the terminal status
12. `stopped`
    - terminal state for `--once` or a received stop signal

Allowed transitions:

1. `bootstrapping -> acquiring-loop-lock`
2. `acquiring-loop-lock -> sleeping` in continuous mode once the initial idle
   status is published
3. `acquiring-loop-lock -> preparing-cycle` in `--once` mode
4. `sleeping -> preparing-cycle`
5. `preparing-cycle -> acquiring-active-lease`
6. `acquiring-active-lease -> running-command`
7. `acquiring-active-lease -> recording-failure` when a live lease holder
   blocks the cycle
8. `running-command -> post-cycle-refresh`
9. `post-cycle-refresh -> recording-success` on exit code `0`
10. `post-cycle-refresh -> recording-failure` on non-zero exit or orchestration
    failure
11. `recording-success -> sleeping` in continuous mode
12. `recording-failure -> retrying` in continuous mode
13. `retrying -> preparing-cycle`
14. any non-terminal state -> `stopping` on `INT` or `TERM`
15. `stopping -> stopped`

### Coordination Artifact Model

The loop should treat lock and lease ownership as typed records with three
normalized states:

1. `absent`
2. `held-live`
3. `held-stale`

Transitions:

1. `absent -> held-live` on successful acquire
2. `held-live -> absent` on owned release
3. `held-stale -> absent` on stale-owner cleanup
4. `held-live` by another owner blocks acquisition and becomes a rejected
   launch or failed cycle depending on whether the artifact is the outer loop
   lock or the per-cycle active wake-up lease

## Failure-Class Matrix

| Observed condition                                | Local facts available                                   | Normalized decision                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Loop lock directory exists and owner pid is live  | lock path, owner pid, selected instance key             | reject second top-level loop launch and leave the current owner untouched                                    |
| Loop lock directory exists and owner pid is dead  | lock path, dead pid, same instance key                  | clear stale lock and retry acquisition                                                                       |
| Active wake-up lease exists and owner pid is live | lease path, owner pid, owner workflow/instance metadata | fail the current cycle before command execution, record the failure, keep the outer loop alive               |
| Active wake-up lease exists and owner pid is dead | lease path, dead pid                                    | clear stale lease and retry acquisition                                                                      |
| Nested operator launch inherits parent-loop env   | inherited parent env markers                            | fail fast before any lock or lease acquisition                                                               |
| Release-state refresh fails                       | checker error, existing release-state path              | continue the cycle, but publish degraded release status and preserve the error in status/log surfaces        |
| Ready promotion fails                             | promoter error, existing release-state path             | continue the cycle, but mark release advancement unavailable or sync-failed in typed status                  |
| Operator command exits non-zero                   | exit code, cycle log path, session mode                 | record failed cycle, clear incompatible stored session when required, and sleep for retry in continuous mode |
| Status/progress publication fails mid-cycle       | write error, current cycle metadata                     | fail the cycle, preserve log evidence, and prefer a terminal failed status over silent drift                 |
| Signal arrives during sleep or active cycle       | signal name, held lock/lease facts                      | mark stopping, interrupt sleeper if needed, release owned coordination artifacts, and write terminal status  |

## Storage And Persistence Contract

This slice should preserve the existing operator-local artifact layout under
`.ralph/instances/<instance-key>/`:

1. `status.json`
2. `status.md`
3. `control-state.json`
4. `release-state.json`
5. `operator-session.json`
6. `standing-context.md`
7. `wake-up-log.md`
8. `logs/operator-cycle-*.log`
9. coordination directories/files for the loop lock and active wake-up lease

The typed runtime should:

1. remain the sole writer for loop-lock and active-lease ownership records
2. preserve compatibility with stale ownership records left by the current
   shell implementation long enough to recover cleanly after deploy
3. keep status and progress writes atomic through the existing observability
   helpers
4. avoid introducing a second durable state store for wake-up coordination

## Observability Requirements

1. `status.json` and `status.md` must continue to expose loop state,
   provider/model/command metadata, control-state posture, release-state
   summary, session state, cycle outcome, and milestone progress
2. cycle logs must continue to show the selected workflow, command summary,
   control posture, and session mode for each wake-up
3. lock/lease failures and stale-owner recovery must remain visible through log
   output and test assertions, not only through hidden retries
4. the shell wrapper should no longer need to assemble JSON by hand for the
   operator status surface

## Implementation Steps

1. Introduce typed operator runtime modules for:
   - loop bootstrap/context
   - coordination lock and active-lease handling
   - wake-up cycle orchestration
   - operator command environment assembly and execution result handling
2. Add a typed operator runtime CLI entrypoint under `bin/` that accepts the
   current operator-loop CLI surface and becomes the canonical executable.
3. Refactor `skills/symphony-operator/operator-loop.sh` into a thin wrapper
   that validates the prompt path and invokes the typed runtime entrypoint.
4. Repoint existing operator-loop integration tests so they continue to cover
   the shell wrapper while asserting the typed runtime-owned behavior.
5. Add focused unit coverage for the new state machine, lock/lease recovery,
   and cycle outcome handling.
6. Update the operator docs only where they need to describe the new typed
   boundary explicitly.

## Tests

Planned coverage:

1. unit tests for typed loop-lock acquisition, stale-owner cleanup, and
   conflicting-owner rejection
2. unit tests for active wake-up lease acquisition and pre-command failure
   behavior
3. unit tests for the operator runtime state machine and transition decisions
   across success, failure, retry, and signal-stop cases
4. unit tests for environment shaping and status/progress transitions around a
   wake-up cycle
5. integration tests for `skills/symphony-operator/operator-loop.sh` proving
   the wrapper still supports:
   - workflow selection
   - once-mode success/failure
   - resumable-session command shaping
   - active-lease conflict handling
   - stale coordination-artifact recovery
6. regression coverage that status/progress artifacts and cycle logs remain
   inspectable after the shell becomes a thin wrapper

## Acceptance Scenarios

1. `pnpm operator:once -- --workflow <path>` runs through the thin shell
   wrapper, completes one cycle through the typed runtime, and leaves the same
   inspectable status/control/session artifacts as before.
2. A stale loop lock or active wake-up lease from a dead pid is recovered
   automatically by typed coordination services and does not require manual
   shell cleanup.
3. A live conflicting active wake-up lease causes the cycle to fail before the
   operator command starts, and the failure is recorded in status and the cycle
   log.
4. A successful resumable-session wake-up still captures or refreshes
   `operator-session.json` through the typed runtime path.
5. A release-state refresh or ready-promotion failure still surfaces as
   degraded release information without silently skipping cycle recording.
6. The selected operator prompt still receives the existing environment
   contract, so repo-owned operator policy work remains compatible.

## Exit Criteria

1. the operator loop state machine is implemented in typed services and covered
   by direct tests
2. `operator-loop.sh` is a minimal bootstrap wrapper rather than the owner of
   cycle control logic
3. the existing operator artifacts and command surface remain compatible
4. typecheck, lint, unit tests, integration tests, and the relevant end-to-end
   checks pass
5. the PR clearly shows the shared-mechanics seam needed before further
   repo-owned operator policy work

## Deferred To Later Issues Or PRs

1. repo-owned operator playbook and init scaffolding work in `#330`
2. additional live status milestone behavior in `#344`
3. any redesign of release-state semantics beyond the typed-service extraction
   needed here
4. any migration from the shell wrapper to a direct user-facing Node entrypoint
   if that becomes desirable later
5. broader operator automation beyond replacing the shell-owned deterministic
   control plane
