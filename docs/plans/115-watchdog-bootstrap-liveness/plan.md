# Issue 115 Plan: Watchdog Bootstrap Liveness Wiring

## Summary

- Wire the existing stalled-runner watchdog into the production CLI bootstrap path.
- Enable the repo-owned watchdog block in `WORKFLOW.md` so live factory runs can recover wedged agent processes.
- Keep the slice narrow: configuration parsing, CLI orchestration bootstrap, runtime contract docs, and focused tests.

## Review Status

- Plan review is explicitly waived by operator/user instruction for this runtime-fix slice.

## Abstraction Mapping

- Policy: keep stall recovery fail-closed and retry-based rather than silently tolerating wedged runners.
- Configuration: parse and validate `polling.watchdog` from `WORKFLOW.md`.
- Coordination: ensure the orchestrator receives a real liveness probe in production bootstrap.
- Execution: no runner-protocol redesign; reuse current log/diff/head-sha liveness signals.
- Integration: wire CLI/runtime startup to construct `FsLivenessProbe`.
- Observability: preserve watchdog status actions and make the live runtime contract explicit in docs.

## Scope

- Add workflow parsing for `polling.watchdog`.
- Enable watchdog config in repo `WORKFLOW.md`.
- Pass `FsLivenessProbe` into `BootstrapOrchestrator` in the production CLI path.
- Add focused tests for watchdog config loading and the CLI/bootstrap wiring effect.

## Non-goals

- Redesigning the watchdog heuristics.
- Introducing a richer heartbeat/session protocol.
- Changing merge/review policy.
- Taking over active implementation on `#113`.

## Current Gap

- `BootstrapOrchestrator` has watchdog logic.
- `FsLivenessProbe` exists.
- Production `runCli()` never passes a probe.
- Repo `WORKFLOW.md` does not enable `polling.watchdog`.
- Result: stalled `codex exec` processes can remain alive indefinitely with stale status snapshots and no recovery.

## Architecture Boundaries

- `src/config/workflow.ts`: parse boundary only; do not embed recovery policy here.
- `src/cli/index.ts`: production composition root; wire the probe here instead of burying filesystem behavior in orchestrator internals.
- `src/orchestrator/*`: keep existing stall logic intact unless a test exposes a real correctness bug.
- `WORKFLOW.md`: repo-owned runtime contract; watchdog enablement belongs here.

## Implementation Steps

1. Add `polling.watchdog` parsing and validation in `src/config/workflow.ts`.
2. Update `src/cli/index.ts` to construct `FsLivenessProbe` with the configured workspace root and pass it to `BootstrapOrchestrator`.
3. Enable watchdog settings in repo `WORKFLOW.md`.
4. Add focused unit coverage for watchdog config parsing.
5. Add CLI/bootstrap coverage proving the production path runs with watchdog enabled and can recover a stalled runner.

## Tests

- `tests/unit/workflow.test.ts`
  - parses valid watchdog config
  - rejects malformed watchdog config
- `tests/unit/cli.test.ts`
  - production `runCli --once` with enabled watchdog recovers a stalled runner instead of hanging forever

## Acceptance Scenarios

- A valid `polling.watchdog` block loads into resolved config.
- A malformed watchdog block fails fast with `ConfigError`.
- Production CLI bootstrapping arms the watchdog with a filesystem liveness probe.
- A stalled run is aborted and retried/fails according to existing watchdog policy instead of staying live forever.

## Exit Criteria

- Repo `WORKFLOW.md` explicitly enables watchdog recovery.
- Production CLI path provides `FsLivenessProbe`.
- Focused tests pass and demonstrate production wiring works.
- PR is green and review-clean.

## Deferred

- Refining stall heuristics or thresholds.
- Richer runner heartbeats.
- Broader operator controls around stalled-run inspection.
