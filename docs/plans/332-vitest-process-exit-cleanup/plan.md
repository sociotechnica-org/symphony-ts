# Issue 332 Plan: Fix Local `pnpm test` Lingering Vitest Process After Passing Output

## Status

- plan-ready
- Issue: #332
- Branch: `symphony/332`
- Plan path: `docs/plans/332-vitest-process-exit-cleanup/plan.md`

## Goal

Make local `pnpm test` exit cleanly after the suite passes, without relying on `--no-verify`, by fixing the repo-owned shutdown leak that keeps the Vitest process alive after test output completes.

The intended outcome of this slice is:

1. local `pnpm test` completes and returns control to the shell without a lingering Vitest parent/worker process
2. the root cause is isolated to one repo-owned shutdown seam instead of papered over with a broad Vitest workaround
3. regression coverage catches the same leak before it reaches another completion run

## Scope

This slice covers:

1. reproducing the hang in a focused way and keeping that reproducer explicit in checked-in tests or helpers where practical
2. fixing the repo-owned cleanup leak on the `operator-loop` integration/process-management seam
3. adding a deterministic regression that proves the focused hanging slice exits cleanly
4. re-running the full local validation path so `pnpm test` exits normally

## Non-goals

This slice does not include:

1. changing already-merged functional behavior from `#329` unless the shutdown leak is directly inside the same code path
2. broad Vitest configuration changes just to mask hanging subprocesses
3. unrelated test-suite refactors outside the minimal process-lifecycle seam required to make exit deterministic
4. production orchestrator policy changes unless the reproducer proves the lingering process comes from production-owned shell/process teardown rather than test-only cleanup

## Current Gaps

Current local evidence points to one narrow failing seam:

1. full `pnpm test` prints passing output but leaves the Vitest parent and worker pool alive instead of exiting
2. `pnpm vitest run tests/e2e/bootstrap-factory.test.ts` exits cleanly on its own, so the hang is not caused by the broad GitHub bootstrap suite in isolation
3. `pnpm vitest run tests/integration/operator-loop.test.ts` reproduces the hang by itself and still needed to be terminated after a 45 second timeout
4. `tests/integration/operator-loop.test.ts` contains several long-lived subprocess scenarios that spawn `skills/symphony-operator/operator-loop.sh` and currently clean up by signaling only the immediate spawned process
5. the likely failure mode is a repo-owned descendant-process cleanup gap on that integration seam, not a generic Vitest assertion failure

## Decision Notes

1. Keep the first slice centered on `tests/integration/operator-loop.test.ts` and shared process-cleanup support. That is the narrowest reproducible seam today.
2. Prefer explicit test-owned subprocess lifecycle helpers over ad hoc `kill("SIGTERM")` blocks repeated across individual tests.
3. Only touch `skills/symphony-operator/operator-loop.sh` if the reproducer proves the script itself fails to shut down descendants cleanly when the parent loop is signaled.
4. Do not treat a longer timeout or different Vitest pool setting as a real fix unless the underlying leaked repo-owned process is also addressed.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

- Policy Layer
  - belongs: the repository-owned rule that local validation must exit cleanly, not merely finish assertions
  - does not belong: one-off operator workarounds such as permanent `--no-verify`
- Configuration Layer
  - belongs: unchanged unless a narrowly justified test-runner configuration adjustment is needed after the leak is fixed
  - does not belong: masking a leaked process with looser timeouts or hidden per-machine settings
- Coordination Layer
  - belongs: test-harness coordination of spawned operator-loop subprocess lifecycle when integration tests intentionally hold or interrupt long-running loops
  - does not belong: production dispatch, retry, reconciliation, or handoff policy changes for this issue
- Execution Layer
  - belongs: repo-owned subprocess spawn/teardown mechanics in shared test helpers and, only if proven necessary, operator-loop shell shutdown behavior
  - does not belong: tracker lifecycle policy or report generation semantics
- Integration Layer
  - belongs: the integration seam between `tests/integration/operator-loop.test.ts` and `skills/symphony-operator/operator-loop.sh`
  - does not belong: tracker transport, normalization, or GitHub/Linear API behavior changes
- Observability Layer
  - belongs: focused logging/assertion support that makes leaked-process failures visible and deterministic in tests
  - does not belong: becoming the primary fix for leaked subprocess ownership

## Architecture Boundaries

### `tests/integration/operator-loop.test.ts`

Owns:

1. reproducing operator-loop subprocess lifecycle scenarios
2. using shared helpers that start, interrupt, and fully clean up long-lived test subprocesses
3. asserting that the focused operator-loop slice exits normally after tests complete

Does not own:

1. bespoke inline descendant-process cleanup logic repeated across cases
2. generic Vitest lifecycle policy

### `tests/support/process.ts` or a new focused test support helper

Owns:

1. reusable process-tree or process-group termination helpers for integration tests
2. bounded wait helpers that fail clearly when a descendant process stays alive
3. platform-aware cleanup behavior needed by this repository's local test environment

Does not own:

1. product runtime policy
2. tracker or orchestrator behavior

### `skills/symphony-operator/operator-loop.sh`

Owns:

1. shutting down its own child command/processes cleanly when the loop receives a signal, if the reproducer shows the leak is inside the script

Does not own:

1. Vitest worker lifecycle
2. test-specific cleanup logic that belongs in shared support helpers

## Layering Notes

- `config/workflow`
  - unchanged for this slice
- `tracker`
  - unchanged
- `workspace`
  - unchanged
- `runner`
  - unchanged unless the root cause proves a shared subprocess helper belongs there, which is not the current expectation
- `orchestrator`
  - unchanged in production behavior
- `observability`
  - may gain clearer failure reporting for cleanup assertions, but should not absorb the actual fix

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one test/process seam:

1. isolate the hanging subprocess ownership path inside `tests/integration/operator-loop.test.ts`
2. introduce or refine one shared cleanup helper for long-lived spawned processes
3. update the affected operator-loop integration cases to use that helper
4. make the focused regression and full `pnpm test` path exit cleanly

Deferred from this PR:

1. broader modernization of all integration-test process helpers
2. unrelated Vitest reporter/pool reconfiguration
3. any production-orchestrator refactor not required by the verified root cause

Why this seam is reviewable:

1. it addresses one concrete operator-confidence failure mode
2. it avoids mixing tracker, orchestrator, and report changes into a test-harness fix
3. it gives the reviewer one narrow question: do spawned operator-loop descendants now shut down deterministically?

## Runtime State Model

This issue does not change production retries, continuations, reconciliation, leases, or handoff states, so no production orchestrator state-machine change is required.

It does require one explicit test-time subprocess lifecycle model for long-lived integration children:

1. `spawned`
   - the integration test started a long-lived operator-loop process
2. `observed-ready`
   - the test has seen the condition it needs from that child and can begin shutdown
3. `shutdown-requested`
   - the test has signaled the parent process or process group to stop
4. `fully-exited`
   - the parent and any repo-owned descendants are gone within the bounded wait window
5. `leaked`
   - at least one repo-owned descendant remains alive after shutdown was requested

Allowed transitions:

1. `spawned -> observed-ready`
2. `observed-ready -> shutdown-requested`
3. `shutdown-requested -> fully-exited`
4. `shutdown-requested -> leaked`

The regression should fail on `leaked`, not silently leave cleanup to Vitest process shutdown.

## Failure-Class Matrix

| Observed condition                                                            | Local facts available                                                | Expected decision                                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Focused operator-loop test finishes and all spawned processes exit            | parent pid dead, descendant pids dead                                | pass normally and allow Vitest to exit                                            |
| Parent test process exits but a repo-owned descendant remains alive           | parent pid dead, descendant pid still live                           | fail the test with a clear cleanup error                                          |
| Parent ignores `SIGTERM` within the bounded window                            | parent pid still live after grace period                             | escalate to stronger termination in the shared helper and fail if still not gone  |
| Shell parent exits but operator child/grandchild keeps the group alive        | immediate child dead, descendant or process-group members still live | fix test helper or shell cleanup so descendants are terminated deterministically  |
| Focused slice exits cleanly but full `pnpm test` still hangs                  | operator-loop slice clean, whole-suite hang persists                 | continue narrowing to the next leaking file before widening the fix               |

## Storage / Persistence Contract

No durable runtime or tracker storage changes are expected in this slice.

If a regression needs temporary files for descendant pid tracking, keep them test-local under temp roots and do not change the product artifact contract.

## Observability Requirements

1. when a cleanup regression occurs, the failing test should say which parent or descendant process remained alive
2. the focused reproducer should be easy to run locally without waiting for the whole suite
3. successful local validation should demonstrate both the focused slice and `pnpm test` exiting cleanly

## Implementation Steps

1. Reproduce the focused hang on `tests/integration/operator-loop.test.ts` and identify which spawned-process scenarios leak descendants.
2. Add or refine a shared process-cleanup helper in `tests/support/` that can terminate and verify the full repo-owned child tree or process group, not just the immediate parent shell.
3. Update the affected operator-loop integration cases to use the shared helper instead of ad hoc `kill("SIGTERM")` cleanup.
4. If the leak is inside `skills/symphony-operator/operator-loop.sh`, tighten that script's signal/shutdown behavior narrowly enough to ensure children do not outlive the loop.
5. Add a focused regression that fails when the operator-loop integration slice leaves a live process behind after completion.
6. Re-run the focused slice first, then full local validation.

## Tests And Acceptance Scenarios

### Focused regression

1. `pnpm vitest run tests/integration/operator-loop.test.ts`
   - exits with status `0`
   - returns control to the shell without an additional manual kill

### Suite validation

1. `pnpm test`
   - exits with status `0`
   - does not leave the Vitest parent or worker pool alive after the last passing output

### Acceptance scenarios

1. A long-lived operator-loop integration test that intentionally spawns a continuous or sleeping loop cleans up all repo-owned descendants before the test finishes.
2. A focused operator-loop-only Vitest run exits normally without hanging after the last test summary.
3. The full repository `pnpm test` run exits normally after passing output, with no need for `--no-verify`.

## Exit Criteria

1. the root-cause leak is fixed on the focused operator-loop/test-process seam
2. a deterministic regression would fail if that leak comes back
3. local validation passes cleanly:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`

## Deferred To Later Issues Or PRs

1. broader consolidation of every subprocess helper used across all test files
2. unrelated Vitest performance tuning or worker-pool changes
3. any larger operator-loop feature work outside deterministic shutdown/cleanup
