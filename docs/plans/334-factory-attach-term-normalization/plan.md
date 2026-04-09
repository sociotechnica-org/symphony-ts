# Issue 334 Plan: Normalize Factory Attach TERM Without Degrading TUI Rendering

## Status

- plan-ready

## Goal

Make `symphony factory attach` tolerate incompatible operator terminal `TERM`
values on macOS and Linux without requiring a shell-level workaround, while
keeping full-screen TUI rendering as close as possible to the operator's real
terminal capabilities.

This slice should stay inside the attach-client seam: normalize the attach
client's terminal environment before launching the brokered `screen -x`
process, preserve the existing safe-detach contract from `#232` / `#240`, and
avoid degrading the detached runtime's own UTF-8 launch contract from `#148`.

## Scope

- inspect and update the attach launch path in
  [`src/cli/factory-attach.ts`](../../../src/cli/factory-attach.ts)
- add a focused attach-local `TERM` normalization helper instead of inheriting
  the operator shell `TERM` blindly
- keep the normalization limited to the attach child environment on macOS and
  Linux
- preserve the existing attach safety contract: one-session preflight,
  brokered local `Ctrl-C`, resize forwarding, and terminal restoration
- add regression coverage for `TERM` selection, child-env forwarding, and the
  broken long-`TERM` attach case
- update operator-facing docs so `factory attach` no longer depends on manual
  `TERM=...` shell folklore

## Non-goals

- changing detached `factory start` / `factory restart` locale or `TERM`
  normalization behavior
- redesigning the TUI layout or color model
- changing tracker, orchestrator, workspace, or runner contracts
- replacing GNU Screen or the existing attach broker model
- adding new `WORKFLOW.md` configuration for attach terminal behavior in this
  slice
- broad host portability work beyond the current macOS/Linux attach contract

## Current Gaps

- [`src/cli/factory-attach.ts`](../../../src/cli/factory-attach.ts) launches
  the Linux `script` wrapper or the macOS helper with `env: process.env`,
  inheriting the operator's `TERM` without validation or normalization
- on some hosts, GNU Screen rejects long or otherwise incompatible `TERM`
  values during `screen -x` with `$TERM too long - sorry`, causing attach to
  exit before the broker can render the TUI
- the documented workaround of forcing `TERM=xterm-256color` is outside the
  repo-owned runtime contract and can reduce rendering fidelity relative to the
  operator's real terminal
- existing unit coverage locks the attach command, PTY helper, and safe-detach
  behavior, but does not cover attach-local `TERM` selection or env forwarding
- operator docs still imply that the supported `factory attach` path should
  work directly from the caller's terminal environment

## Decision Notes

- Keep this issue inside the attach-launch seam. The bug is not a detached
  runtime startup problem and should not reopen the `#148` locale work.
- Normalize `TERM` only for the brokered attach child, not for the parent
  process or the detached runtime session.
- Prefer a typed normalization result that distinguishes passthrough versus
  compatibility fallback so the code and tests can state when Symphony is
  preserving the operator term and when it is intentionally downgrading to a
  shorter screen-compatible value.
- Keep the fallback policy explicit and small. If preserving the original
  `TERM` is unsafe, choose the closest supported short-form terminal contract
  that preserves 256-color/full-screen behavior as well as practical in one
  reviewable slice.
- Do not hide this behind workflow config. This is attach transport hygiene,
  not repo-specific policy.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in
[`docs/architecture.md`](../../architecture.md).

- Policy Layer
  - belongs: the repo-owned rule that `factory attach` should absorb known
    incompatible operator `TERM` inputs instead of requiring manual shell
    overrides
  - belongs: the rule that any attach fallback should preserve TUI fidelity as
    closely as practical, not force a broad downgrade unconditionally
  - does not belong: host-specific spawn/env plumbing or `screen` argv details
- Configuration Layer
  - belongs: fixed attach-terminal normalization defaults and any small typed
    constants used by the attach launch seam
  - does not belong: new `WORKFLOW.md` fields, tracker settings, or user-tuned
    terminal overrides in this slice
- Coordination Layer
  - belongs: attach preflight still resolves exactly one healthy detached
    target and now also decides which attach-local terminal contract to launch
  - does not belong: orchestrator polling, retries, reconciliation, leases, or
    handoff policy
- Execution Layer
  - belongs: launching the attach child with the normalized environment while
    preserving the existing input/output, signal, and cleanup behavior
  - does not belong: workspace lifecycle or runner behavior changes
- Integration Layer
  - belongs: host-specific attach-child env construction for Linux `script`,
    the macOS helper, and any small helper extraction needed to keep that
    behavior testable
  - does not belong: tracker transport, tracker normalization, or tracker
    lifecycle policy
- Observability Layer
  - belongs: operator-facing docs and errors that explain the supported attach
    behavior without requiring manual `TERM=...` workarounds
  - does not belong: status snapshot schema changes or TUI redesign

## Architecture Boundaries

### Attach policy seam

Belongs here:

- interactive-terminal preflight
- detached-session resolution
- choosing a normalized attach-local terminal contract before launch
- preserving the existing local-detach and terminal-restore contract

Does not belong here:

- platform-specific env mutation spread across unrelated signal or policy
  branches
- detached runtime startup or status-snapshot logic

### Attach terminal normalization seam

Belongs here:

- a focused helper that inspects inherited attach env facts and returns:
  - the terminal name to launch with
  - whether the result is passthrough or fallback
  - any narrow metadata needed for tests or operator-facing diagnostics
- keeping the fallback order explicit and reviewable

Does not belong here:

- screen-session selection
- tracker/orchestrator concerns
- a general repo-wide terminal abstraction

### Host integration seam

Belongs here:

- threading the normalized attach env into Linux `script` launches and the
  macOS helper launch path
- keeping platform differences behind the existing launch helper boundary
- surfacing clear attach-launch failures if the child still cannot start

Does not belong here:

- attach policy decisions
- detached start/restart locale handling

### Observability and docs seam

Belongs here:

- updating README and operator guidance to remove the manual `TERM=...`
  workaround from the supported path
- documenting that `factory attach` now normalizes incompatible terminal env
  itself while keeping `Ctrl-C` scoped to the attach client

Does not belong here:

- TUI redesign
- new persistent status/read-model fields

### Untouched seams

- tracker adapters remain unaware of attach terminal compatibility
- workspace code does not absorb attach env logic
- runner implementations continue to see the same detached runtime environment
- orchestrator state and retry/reconciliation logic remain unchanged

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR focused on the attach-launch seam:

1. add one focused attach-terminal normalization helper
2. thread the normalized env into the existing attach child launch path
3. lock the behavior with focused unit coverage and one realistic command-path
   regression
4. update operator docs for the supported no-workaround attach path

Deferred from this PR:

- broader terminal capability probing beyond the narrow attach fix
- configurable attach terminal overrides
- detached startup/runtime env redesign
- TUI feature or rendering redesign
- replacing Screen or the attach broker transport

This seam is reviewable because it stays inside CLI attach integration, tests,
and docs. It does not mix tracker edges, orchestrator state, or detached
runtime startup behavior.

## Attach Launch State Model

This issue does not change the detached factory runtime state machine. It adds
an explicit attach-launch normalization step inside the existing process-local
attach client flow.

### States

1. `preflight`
   - validate interactive parent terminal and resolve one healthy detached
     target
2. `select-terminal-contract`
   - inspect inherited attach env and choose passthrough or compatibility
     fallback `TERM`
3. `launching`
   - start the Linux `script` wrapper or macOS helper with the normalized env
4. `attached`
   - brokered attach is running and the full-screen TUI is visible
5. `detaching`
   - the local client exits on `Ctrl-C`, signal, or normal child completion
6. `detached`
   - the local terminal is restored and the detached worker remains alive when
     expected
7. `attach-failed`
   - preflight, terminal-contract selection, launch, or cleanup failed with an
     explicit operator-facing error

### Allowed Transitions

- `preflight -> select-terminal-contract`
- `preflight -> attach-failed`
- `select-terminal-contract -> launching`
- `select-terminal-contract -> attach-failed`
- `launching -> attached`
- `launching -> attach-failed`
- `attached -> detaching`
- `detaching -> detached`
- `attached -> attach-failed`

### Contract Rules

- attach still targets exactly one selected detached session
- terminal normalization is local to the attach child env
- local `Ctrl-C` / `SIGINT` / `SIGTERM` handling remains owned by Symphony, not
  raw `screen`
- the local terminal must still be restored on both success and failure paths

## Failure-Class Matrix

| Observed condition                                                      | Local facts available                                         | Attach-normalization facts available                         | Expected decision                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Inherited `TERM` is already compatible                                  | interactive TTY, supported platform, healthy detached session | helper classifies `TERM` as passthrough-safe                 | launch attach with the original `TERM`; preserve current rendering contract                     |
| Inherited `TERM` is too long or otherwise known-incompatible for Screen | same as above plus inherited `TERM` value                     | helper selects an explicit shorter compatibility terminal    | launch attach with the normalized `TERM`; no manual shell override required                     |
| Inherited `TERM` is missing or empty                                    | same as above                                                 | helper selects the default short-form compatibility terminal | launch attach with the explicit fallback instead of inheriting an empty terminal contract       |
| Attach child still exits unexpectedly after normalization               | child exit status / stderr                                    | normalization result is known                                | surface attach failure clearly; do not stop the detached worker                                 |
| Operator presses `Ctrl-C` while attached                                | local detach byte/signal observed                             | normalized env already applied to child                      | detach the foreground client, restore the terminal, and leave the detached runtime alive        |
| Detached control is stopped or degraded                                 | selected workflow path, local terminal                        | no valid target session                                      | keep the current explicit preflight failure; do not attempt attach or terminal fallback guesses |

## Storage / Persistence Contract

- no new durable runtime files
- no tracker-side state changes
- no workflow/config surface changes
- attach terminal normalization remains an in-memory launch-time decision inside
  `factory attach`

## Observability Requirements

- `factory attach` should no longer require operator docs to prescribe manual
  `TERM=...` exports for this failure mode
- attach failures should remain explicit and actionable if launch still fails
  after normalization
- tests should prove that attach fallback changes the child env only; it must
  not weaken the existing safe-detach semantics
- if the command emits a note about local terminal normalization, keep it
  concise and avoid cluttering the TUI; otherwise keep the behavior silent and
  documented

## Implementation Steps

1. Add a focused helper near
   [`src/cli/factory-attach.ts`](../../../src/cli/factory-attach.ts) that
   evaluates inherited attach env and selects a passthrough or compatibility
   fallback `TERM`.
2. Extend the attach launch contract so the chosen env is passed into the Linux
   `script` path and the macOS helper path without changing the parent process
   env.
3. Keep the existing attach preflight, safe local detach, resize forwarding,
   and terminal restoration logic unchanged except where the env threading seam
   requires small refactoring.
4. Add focused regression coverage for:
   - compatible `TERM` passthrough
   - long/incompatible `TERM` fallback selection
   - normalized env forwarding to the attach child
   - preserved `Ctrl-C` and cleanup behavior after the env change
5. Add one realistic command-path regression, likely via a temp PATH harness or
   stubbed launch seam, that demonstrates attach succeeds under a problematic
   inherited `TERM` without requiring a shell-level override.
6. Update [`README.md`](../../../README.md) and
   [`docs/guides/operator-runbook.md`](../../../docs/guides/operator-runbook.md)
   so the supported attach path describes repo-owned TERM normalization instead
   of manual operator workarounds.

## Tests And Acceptance Scenarios

### Unit tests

- attach terminal selection preserves an already compatible inherited `TERM`
- attach terminal selection chooses the explicit short-form fallback for a long
  or known-incompatible inherited `TERM`
- attach terminal selection produces a fallback when `TERM` is missing or empty
- attach child launch receives the normalized env on Linux and macOS paths
- attach still intercepts local `Ctrl-C` and restores the terminal cleanly
  after the env-threading change

### Integration / realistic harness tests

- a command-path harness with a problematic inherited `TERM` verifies that the
  launched attach child sees the normalized `TERM` instead of the raw parent
  value
- the same harness keeps the detached-worker safety contract intact: attach
  client exit does not imply factory stop

### Acceptance scenarios

1. Given a healthy detached factory and an operator terminal exporting a long
   Screen-incompatible `TERM`, when the operator runs
   `pnpm tsx bin/symphony.ts factory attach`, then attach succeeds without
   requiring `TERM=...` in the shell.
2. Given a healthy detached factory and an already compatible `TERM`, when the
   operator runs `factory attach`, then Symphony preserves the original term
   rather than forcing a broad downgrade.
3. Given the operator is attached through the normalized path, when they press
   `Ctrl-C`, then the attach client exits and `factory status` still reports
   the detached runtime alive.
4. Given detached control is stopped or degraded, when the operator runs
   `factory attach`, then the command still refuses attach with the existing
   explicit guidance instead of trying to compensate.

## Exit Criteria

- `factory attach` no longer fails on the known long-`TERM` regression without
  a manual shell override
- attach fallback logic is explicit, tested, and limited to the attach child
  environment
- existing attach safety semantics remain intact
- docs describe the supported no-workaround attach path accurately
- relevant local checks for the touched seam pass

## Deferred To Later Issues Or PRs

- user-configurable terminal compatibility overrides
- broader terminal capability probing or richer terminfo negotiation
- detached runtime startup env redesign
- any TUI redesign or broader rendering-fidelity project outside the attach
  regression
