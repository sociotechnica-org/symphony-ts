# Issue 127 Plan: Harden Factory Control CLI Degraded-State Contract

## Status

- plan-ready

## Goal

Tighten the `symphony factory` control contract so degraded cleanup or degraded final control state is surfaced consistently instead of being silently treated as success.

This follow-up stays within the existing factory-control CLI seam from issue `#81` / PR `#126`. It should preserve the detached-runtime model while making degraded outcomes explicit and scriptable.

## Scope

- preserve and surface degraded cleanup results encountered during `factory start`
- define one exit-code contract for degraded final state across `factory start`, `factory stop`, `factory restart`, and `factory status`
- remove or narrowly justify unreachable missing-screen-session handling in `isMissingScreenSessionError`
- add focused unit coverage for the corrected start, stop, restart, and missing-session paths

## Non-goals

- changing the detached runtime model, `screen` launcher, or runtime checkout layout
- redesigning status snapshot freshness rules or the `.tmp/status.json` schema
- refactoring tracker, orchestrator, or runner behavior outside the existing factory-control seam
- adding new persistent control-state files or operator configuration
- broad CLI UX changes beyond messages and exit-code signaling required for degraded results

## Current Gaps

- `startFactory` stops a degraded runtime but discards the stop result before launching, so degraded cleanup can be lost
- `factory status` treats degraded control state as non-zero, but `factory start`, `factory stop`, and `factory restart` do not
- `isMissingScreenSessionError` still carries an `ESRCH` branch that does not match the current `execFile("screen", ...)` call path
- current tests do not pin the degraded-start cleanup contract or degraded exit-code behavior for all subcommands

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

- Policy Layer
  - belongs: the operator contract for whether degraded factory-control outcomes are success, failure, or warning
  - does not belong: tracker lifecycle policy, retry budgeting, or PR-review behavior
- Configuration Layer
  - belongs: no new configuration; existing fixed control defaults remain unchanged
  - does not belong: introducing workflow knobs for degraded exit-code policy in this follow-up
- Coordination Layer
  - belongs: final command-result classification when control cleanup/startup transitions through `degraded`
  - does not belong: orchestrator poll-loop or run-ownership state changes
- Execution Layer
  - belongs: stop-before-start cleanup sequencing, launch gating, and `screen` quit error interpretation
  - does not belong: status rendering policy beyond exposing already-computed results
- Integration Layer
  - belongs: the local host integration with `screen -S ... -X quit` and its actual error surface
  - does not belong: tracker adapters or external service normalization
- Observability Layer
  - belongs: preserving degraded cleanup/final-state information in returned control snapshots and CLI output
  - does not belong: inventing a second persisted status surface or new snapshot schema

## Architecture Boundaries

### CLI

Belongs here:

- mapping final `FactoryControlStatusSnapshot.controlState` to `process.exitCode`
- rendering subcommand-specific summaries while preserving the returned control snapshot

Does not belong here:

- recomputing degraded state from raw process facts
- encoding `screen`-specific missing-session heuristics inline

### Factory control module

Belongs here:

- deciding whether degraded pre-start cleanup blocks launch or returns an explicit degraded result
- returning enough status to let the CLI apply one coherent exit-code rule
- keeping missing-screen-session detection aligned with the real `execFile` error shape

Does not belong here:

- tracker policy
- workflow/config changes
- unrelated process-discovery refactors

### Observability/status snapshot seam

Belongs here:

- reusing the existing control snapshot and `problems` list to explain degraded outcomes

Does not belong here:

- schema changes to `.tmp/status.json`
- new persisted “cleanup result” files

## Slice Strategy And PR Seam

One PR should remain reviewable because this issue is a narrow follow-up on the existing factory-control seam:

1. adjust `startFactory` degraded cleanup handling
2. centralize degraded exit-code mapping for the four factory subcommands
3. remove the dead `ESRCH` branch or replace it with a documented reachable path if one exists
4. add unit coverage for each corrected path

Deferred from this PR:

- richer factory-control result enums if future issues need more granular scripting outcomes than `controlState`
- broader process-control refactors or service-manager support
- non-factory CLI exit-code normalization

## Runtime State Model

This issue does not add new durable orchestrator state, but it does change command-level control transitions enough to make the expected outcomes explicit.

### Relevant command states

1. `running`
   - healthy detached runtime exists
2. `degraded`
   - partial runtime state exists or cleanup leaves broken remnants
3. `stopped`
   - no active runtime or owned descendants remain

### Command transitions touched here

- `start`: `degraded -> stop attempt -> stopped -> launch -> running`
- `start`: `degraded -> stop attempt -> degraded`
  - expected result: do not silently continue as if cleanup succeeded; fail closed or return the degraded result explicitly
- `stop`: `running|degraded -> stop attempt -> stopped|degraded`
- `restart`: `running|degraded -> stop attempt -> stopped|degraded -> launch?`
  - restart should honor the same degraded cleanup gate as start and should not mask a degraded final result

## Failure-Class Matrix

| Observed condition                                                 | Local facts available                                               | Status facts available                          | Expected decision                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `startFactory` sees degraded state and cleanup finishes `stopped`  | session/process facts after stop                                    | final control snapshot `stopped`                | continue launch path                                                                             |
| `startFactory` sees degraded state and cleanup finishes `degraded` | lingering session/process facts remain                              | final control snapshot `degraded` with problems | do not silently launch; surface degraded cleanup result explicitly and treat command as non-zero |
| `stopFactory` finishes with degraded control state                 | partial remnants still observed                                     | final control snapshot `degraded`               | render status and exit non-zero                                                                  |
| `restart` stop leg finishes degraded                               | degraded cleanup facts from stop leg                                | stop result status `degraded`                   | do not claim success; keep degraded signal and avoid masking it with a later zero exit code      |
| `screen -S ... -X quit` targets a missing session                  | `execFile` rejects with non-zero command result, stdout/stderr text | no extra status facts needed                    | treat known “no such session” text as benign missing-session race                                |
| `screen -S ... -X quit` fails for another reason                   | `execFile` rejects without matching missing-session text            | no extra status facts needed                    | propagate failure rather than swallowing it                                                      |

## Storage / Persistence Contract

- no new persisted control-state files
- no `.tmp/status.json` schema changes
- degraded cleanup information remains transient in the returned start/stop result and rendered CLI output

## Observability Requirements

- `factory start` must visibly report when degraded cleanup blocked or tainted startup
- `factory start`, `factory stop`, `factory restart`, and `factory status` must expose the same degraded/non-zero scripting contract
- any degraded final result should still include the existing rendered control snapshot so operators can inspect `problems`
- missing-session handling should remain observable through tests and code comments rather than dead defensive branches

## Implementation Steps

1. Update `src/cli/factory-control.ts` so degraded pre-start cleanup is captured in a variable and evaluated before launch.
2. Choose and document the contract for that path:
   - preferred: fail closed by throwing with the degraded cleanup status embedded in the message context
   - acceptable alternative: return an explicit degraded start result that the CLI renders and marks non-zero
3. Extract or add a small helper in `src/cli/index.ts` that sets `process.exitCode = 1` when a factory subcommand ends with `controlState === "degraded"`.
4. Apply that helper to `factory start`, `factory stop`, `factory restart`, and keep `factory status` on the same rule.
5. Remove the dead `ESRCH` branch from `isMissingScreenSessionError` unless a concrete reachable `execFile` path is identified and documented with a test.
6. Extend unit tests in `tests/unit/factory-control.test.ts` for:
   - degraded cleanup during `startFactory`
   - start proceeding only after cleanup resolves to `stopped`
   - missing-session string matching without `ESRCH`
7. Extend unit tests in `tests/unit/cli.test.ts` for degraded exit-code handling on `factory start`, `factory stop`, and `factory restart`.

## Tests And Acceptance Scenarios

### Unit

- `startFactory` returns or throws in a way that explicitly surfaces degraded cleanup instead of launching silently
- `startFactory` still launches when degraded cleanup reaches `stopped`
- `factory stop` sets `process.exitCode = 1` when the final control state is degraded
- `factory start` sets `process.exitCode = 1` when the final control state is degraded
- `factory restart` sets `process.exitCode = 1` when the stop or final start result is degraded, according to the chosen contract
- `isMissingScreenSessionError` recognizes actual `screen` missing-session text and no longer relies on unreachable `ESRCH`

### Integration

- no new integration harness is required if the corrected behavior is fully covered at the factory-control and CLI seams; this follow-up is localized policy/contract hardening

### Acceptance scenarios

- operator runs `symphony factory start` from a degraded state; if cleanup cannot reach `stopped`, the command surfaces that degraded result and exits non-zero
- operator runs `symphony factory stop`; if remnants remain and control stays degraded, the command exits non-zero just like `factory status`
- operator scripts `symphony factory restart`; degraded stop/start outcomes are visible to shell automation through a consistent non-zero exit code
- benign missing-session races from `screen` stop do not fail the command, but unrelated `screen` failures still do

## Exit Criteria

- degraded cleanup during `factory start` is surfaced explicitly and covered by unit tests
- all factory subcommands share one documented degraded/non-zero exit-code contract
- `isMissingScreenSessionError` contains only reachable logic or an explicitly justified branch with coverage
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Deferred

- richer machine-readable factory result types beyond `controlState`
- broader control-surface error taxonomy work
- any follow-up README wording changes unless the final contract differs materially from current docs

## Decision Notes

- Preferred behavior is to fail closed on degraded pre-start cleanup rather than launching into an already-broken local host state. That keeps the operator contract conservative and matches the issue wording.
- Exit-code normalization should key off final `controlState`, not per-command wording, so scripts get one stable rule across the control surface.
