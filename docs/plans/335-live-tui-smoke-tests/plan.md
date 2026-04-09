# Issue 335 Plan: Add Live TUI Smoke Tests Using tui-use

## Status

- plan-ready

## Goal

Add live PTY-aware smoke tests for Symphony's operator-facing TUI surfaces so
CI can exercise the real detached runtime, `factory watch`, and `factory
attach` contracts instead of relying only on static frame dumps and in-process
dashboard rendering.

This slice should make the existing manual smoke path from
[`src/observability/README.md`](../../../src/observability/README.md)
recoverable as checked-in automated coverage. The tests should drive real
terminal sessions through a PTY harness, observe rendered screen state, and
prove the recent attach/watch contracts under the same command paths operators
actually use.

## Scope

- add a focused `tui-use`-backed smoke-test harness under `tests/support/`
- add one or more integration/e2e tests that:
  - start a real detached factory runtime against the existing mock GitHub
    fixture stack
  - observe `symphony factory watch` through a PTY instead of a mocked render
    function
  - observe `symphony factory attach` through a PTY and assert the real
    full-screen TUI surface appears
  - verify local detach from `factory attach` leaves the detached runtime alive
- use the existing long-running fake Codex event fixture so the smoke tests
  exercise real runner telemetry, not an idle dashboard
- isolate `tui-use` daemon/session state per test so the suite remains
  deterministic under Vitest
- document the checked-in live smoke path and its local/CI prerequisites

## Non-goals

- redesigning the TUI layout, colors, or renderer
- replacing existing unit tests, dashboard dump fixtures, or pure render tests
- changing tracker transport, normalization, or policy
- changing orchestrator retry, reconciliation, or handoff policy
- replacing GNU Screen, the attach broker, or the detached runtime lifecycle
- introducing a broad reusable terminal-testing framework beyond the narrow
  Symphony smoke harness needed for this issue
- adding Windows support for PTY smoke testing in this slice

## Current Gaps

- [`tests/unit/tui.test.ts`](../../../tests/unit/tui.test.ts) and the TUI
  integration coverage in
  [`tests/e2e/bootstrap-factory.test.ts`](../../../tests/e2e/bootstrap-factory.test.ts)
  prove in-process rendering, but they do not exercise a real PTY boundary
- [`tests/unit/factory-watch.test.ts`](../../../tests/unit/factory-watch.test.ts)
  and [`tests/unit/factory-attach.test.ts`](../../../tests/unit/factory-attach.test.ts)
  lock command logic and local signal handling, but they do not prove the
  actual terminal surfaces operators see
- [`src/observability/README.md`](../../../src/observability/README.md)
  still describes live TUI smoke testing as a manual path
- recent attach regressions such as the macOS real-TTY issue and the
  Screen-incompatible `TERM` failure escaped because the suite did not drive
  `factory attach` through a real PTY
- the repo does not currently carry a checked-in PTY harness for asserting
  alternate-screen/full-screen transitions or attach/watch screen content

## Decision Notes

- Keep this issue on the observability/integration-test seam. The goal is to
  automate real operator-facing TUI behavior, not to reopen detached-runtime
  architecture.
- Prefer a small checked-in helper around `tui-use` over ad hoc shell polling.
  The helper should express the smoke-test contract in typed test code and keep
  terminal assertions legible.
- Pin `tui-use` as a repo dependency for deterministic CI/local behavior.
  Current published `latest` is `0.1.17`.
- Treat `tui-use` daemon state as test-owned infrastructure. The harness must
  isolate its HOME/session root per test or per sequential suite instead of
  sharing `~/.tui-use` implicitly across the whole Vitest process.
- Reuse the existing mock GitHub server, workflow builder, and fake-agent
  fixtures rather than inventing a separate fake detached runtime.
- Keep the current PR review seam narrow: helper, smoke tests, any tiny test
  support extractions, and docs. Avoid mixing production TUI feature work into
  this issue unless the smoke harness exposes a small correctness bug that must
  be fixed to make the supported path testable.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in
[`docs/architecture.md`](../../architecture.md).

- Policy Layer
  - belongs: the repo-owned rule that detached TUI behavior important to
    operators must have real smoke coverage, not only static frame tests
  - belongs: the rule that supported operator commands remain `factory watch`
    and `factory attach`, not raw `screen` attach folklore
  - does not belong: PTY library internals or low-level daemon socket details
- Configuration Layer
  - belongs: fixed test-owned harness configuration such as PTY size, temp HOME
    roots, and any narrow helper defaults
  - does not belong: new `WORKFLOW.md` fields or user-facing runtime
    configuration for smoke tests in this slice
- Coordination Layer
  - belongs: starting/stopping the detached runtime as part of end-to-end smoke
    setup and asserting the runtime remains alive after local attach detach
  - does not belong: orchestrator retry budgeting, reconciliation, leases, or
    handoff-state redesign
- Execution Layer
  - belongs: the real subprocesses under test, including detached factory
    startup plus PTY-backed watch/attach client execution
  - does not belong: workspace contract redesign or runner transport changes
- Integration Layer
  - belongs: the boundary between Symphony's CLI commands, GNU Screen, and the
    external `tui-use` PTY harness; also any fixture wiring needed to run
    against the mock GitHub environment
  - does not belong: tracker adapter policy or mixed tracker/orchestrator test
    logic
- Observability Layer
  - belongs: proving the operator-visible watch and attach surfaces, their
    fullscreen/alternate-buffer behavior, and docs that point to the automated
    smoke path
  - does not belong: unrelated status snapshot schema changes or TUI redesign

## Architecture Boundaries

### PTY smoke harness seam

Belongs here:

- a small helper that can start `tui-use`, select a per-test daemon root, and
  expose typed operations such as:
  - start command
  - wait for screen text
  - snapshot current screen/fullscreen metadata
  - send keys such as `Ctrl-C`
  - kill/cleanup the current PTY session
- explicit cleanup so a failed test does not leak daemon/session state

Does not belong here:

- business logic assertions about tracker handoff state
- ad hoc shell pipelines embedded directly in tests
- production CLI behavior changes unless needed for a narrow correctness fix

### Detached runtime smoke seam

Belongs here:

- using the existing workflow builder, mock GitHub server, and fake-agent
  fixtures to start a real detached runtime under test
- waiting for a real active issue/run so watch and attach have meaningful TUI
  content to observe
- stopping the detached runtime cleanly during teardown

Does not belong here:

- new tracker mocks outside the existing test support
- broad factory-control refactors unrelated to smoke-test setup

### Watch surface seam

Belongs here:

- asserting the `factory watch` PTY screen contains the expected watch framing
  and live status content
- proving the watch surface is readable through a PTY without attaching to the
  worker-owned terminal directly

Does not belong here:

- attach/full-screen-only assertions
- render-unit expectations already covered in pure TUI tests

### Attach surface seam

Belongs here:

- asserting `factory attach` reaches the real full-screen TUI surface
- proving the PTY snapshot reports fullscreen/alternate-buffer state when the
  attach broker is active
- sending local detach input (`Ctrl-C`) and proving the detached runtime stays
  alive afterwards

Does not belong here:

- raw `screen -x` operator procedure
- redesigning attach key handling beyond the existing safe-detach contract

### Docs seam

Belongs here:

- updating TUI testing docs to describe the automated `tui-use` smoke path and
  its prerequisites
- documenting any narrow CI/local host requirements introduced by the harness

Does not belong here:

- broad operator-runbook rewrites unrelated to smoke testing

### Untouched seams

- tracker adapters remain unchanged beyond existing test-fixture wiring
- orchestrator state machines and retry/review policy remain unchanged
- workspace and runner contracts remain unchanged unless a small testability fix
  is required

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR:

1. add a small `tui-use` smoke-test helper with explicit cleanup/isolation
2. add focused live smoke tests for detached `watch` and `attach`
3. update the TUI testing docs to reflect the checked-in automated path

Deferred from this PR:

- additional PTY smoke coverage for unrelated CLI surfaces
- snapshot diff tooling or generalized screen-assertion DSLs
- production TUI feature work unrelated to enabling the smoke tests
- cross-platform PTY portability beyond the current macOS/Linux contract

This seam is reviewable because it stays in test support, smoke tests, and
docs. It does not mix tracker policy, orchestrator runtime-state changes, or
large production refactors.

## Smoke Harness Runtime State Model

This issue does not change Symphony's production runtime state machine. It adds
an explicit test-harness state model so PTY sessions, detached runtime setup,
and teardown stay legible.

### States

1. `setup`
   - create temp repo/runtime roots, mock GitHub server, and test-owned PTY
     daemon home
2. `runtime-starting`
   - start the detached factory and wait for the runtime to publish a healthy
     selected target
3. `runtime-active`
   - the fake-agent run is live and the watch/attach surfaces have meaningful
     content
4. `watching`
   - the PTY harness is attached to `factory watch`
5. `attached`
   - the PTY harness is attached to `factory attach` and the full-screen TUI is
     visible
6. `detaching`
   - the test sends local detach input to the attach client
7. `verifying-post-detach`
   - the test confirms the detached runtime still reports healthy/running after
     the foreground client exits
8. `teardown`
   - stop the PTY session/daemon and detached runtime, then remove temp roots
9. `failed`
   - setup, PTY interaction, assertion, or cleanup failed

### Allowed transitions

- `setup -> runtime-starting`
- `runtime-starting -> runtime-active`
- `runtime-starting -> failed`
- `runtime-active -> watching`
- `runtime-active -> attached`
- `watching -> attached`
- `watching -> teardown`
- `attached -> detaching`
- `detaching -> verifying-post-detach`
- `verifying-post-detach -> teardown`
- `runtime-active|watching|attached|detaching|verifying-post-detach -> failed`
- `failed -> teardown`

### Contract rules

- each smoke test owns its PTY daemon/session state and must not rely on a
  pre-existing global `~/.tui-use` daemon
- `factory attach` assertions must prove the foreground client detaches without
  stopping the detached worker
- teardown must attempt both PTY cleanup and detached-runtime cleanup even after
  assertion failures

## Failure-Class Matrix

| Observed condition                                                      | Local facts available                                                    | Test-harness facts available                           | Expected decision                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `tui-use` is unavailable or fails to install/build                      | test process, package/bin lookup, install/build stderr                   | no PTY session yet                                     | fail clearly with a local/CI prerequisite error; do not silently skip the covered smoke path                        |
| PTY daemon/session state leaks between tests                            | temp HOME/session root, list of current sessions                         | harness sees existing daemon/socket state before start | use test-owned HOME/root and explicit cleanup so each smoke test starts clean                                       |
| Detached runtime starts but no active TUI content appears               | status snapshot, mock issue seeded, worker process facts                 | PTY snapshot remains idle/no expected text             | fail the smoke test with the captured screen/status evidence instead of weakening assertions to a purely idle frame |
| `factory watch` renders but does not show expected framing/live state   | PTY snapshot lines                                                       | watch command is running, detached runtime healthy     | fail with captured watch screen; keep watch assertions focused on supported operator contract                       |
| `factory attach` launches but never reaches fullscreen/alternate screen | PTY snapshot metadata and lines                                          | attach command running, detached runtime healthy       | fail with attach snapshot evidence; this is the regression class the smoke suite is meant to catch                  |
| `Ctrl-C` exits attach and also stops the detached runtime               | attach client exits, post-detach `factory status` shows stopped/degraded | local detach input recorded                            | fail; the supported attach contract regressed                                                                       |
| Smoke-test teardown hits leaked child processes                         | child pid/process-group facts                                            | PTY session/runtime cleanup step failed                | terminate aggressively in shared test helpers and fail clearly if cleanup still cannot complete                     |

## Storage / Persistence Contract

- no new production runtime files
- test-owned temp directories may hold:
  - instance roots
  - mock remote repos
  - mock GitHub state
  - `tui-use` daemon/session home
- any new helpers should keep these paths explicit so failures remain
  inspectable

## Observability Requirements

- failures must capture enough evidence to debug PTY/TUI mismatches quickly:
  screen snapshot text, fullscreen metadata when relevant, and detached
  `factory status` details
- docs must distinguish static dump QA from automated live PTY smoke coverage
- the smoke suite should keep proving the operator-visible contracts:
  - `factory watch` is the supported live read-only surface
  - `factory attach` reaches the real full-screen TUI
  - local detach keeps the detached runtime alive

## Implementation Steps

1. Add `tui-use` as a test/dev dependency and document the pinned version in
   the smoke-harness notes if needed.
2. Introduce a focused helper under `tests/support/` that wraps the
   `tui-use` CLI or client API with:
   - temp HOME/session isolation
   - start/wait/snapshot/type/press/kill operations
   - explicit daemon/session cleanup
3. Extract any tiny e2e helpers needed to reuse the existing mock GitHub
   workflow builder and fake-agent fixture in the new smoke tests instead of
   duplicating large setup blocks.
4. Add live smoke coverage, likely in a dedicated e2e or integration test file,
   for:
   - `factory watch` through a PTY
   - `factory attach` through a PTY, including fullscreen detection
   - local `Ctrl-C` detach followed by detached-runtime health verification
5. Update [`src/observability/README.md`](../../../src/observability/README.md)
   and any nearby testing docs to describe the automated smoke path and narrow
   prerequisites.
6. Run repo-required checks plus targeted smoke-test execution to prove the
   harness is stable enough for CI.

## Tests And Acceptance Scenarios

### Unit / helper coverage

- helper parsing/cleanup behavior if the new PTY wrapper contains non-trivial
  logic worth isolating
- shared cleanup helpers for spawned child processes/daemon teardown when added

### Integration / e2e coverage

- start a real detached runtime against the mock GitHub server with
  [`tests/fixtures/fake-agent-codex-events.sh`](../../../tests/fixtures/fake-agent-codex-events.sh)
  so the TUI receives realistic live updates
- drive `symphony factory watch` through `tui-use` and assert the PTY screen
  shows the supported watch framing plus live factory content
- drive `symphony factory attach` through `tui-use` and assert:
  - the PTY snapshot reaches the real `SYMPHONY STATUS` surface
  - fullscreen/alternate-screen metadata is true while attached
  - `Ctrl-C` exits the foreground attach client only
  - a follow-up `factory status --json` still reports the detached runtime
    alive

### Acceptance scenarios

1. Given a healthy detached factory run with live Codex-style telemetry, when
   the smoke suite launches `factory watch` through `tui-use`, then the PTY
   screen shows the supported watch surface instead of a mocked/in-process
   render only.
2. Given the same detached runtime, when the smoke suite launches
   `factory attach` through `tui-use`, then the PTY session reaches the real
   full-screen TUI and reports fullscreen/alternate-screen mode.
3. Given the smoke suite is attached through `factory attach`, when it sends
   `Ctrl-C`, then the attach client exits and a subsequent detached status check
   still reports the runtime alive.
4. Given the live TUI smoke path regresses in CI, when the test fails, then the
   failure output includes enough screen/status evidence to debug the PTY
   mismatch without reproducing blindly.

## Exit Criteria

- the repo has checked-in automated PTY smoke coverage for the supported live
  TUI surfaces
- the smoke suite exercises real detached `watch` and `attach` command paths
- the attach smoke test proves fullscreen/alternate-screen behavior plus safe
  local detach
- docs describe the automated live smoke path and its prerequisites
- repo-required checks pass for the touched surface

## Deferred To Later Issues Or PRs

- PTY smoke coverage for unrelated interactive commands beyond `watch` and
  `attach`
- broader test-runner orchestration for optional host capability matrices
- TUI visual diff tooling or richer screenshot artifacts
- any production TUI redesign uncovered by the smoke tests but not required to
  land the harness itself
