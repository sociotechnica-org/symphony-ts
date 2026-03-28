# Issue 240 Plan: Fix macOS Factory Attach When Launched From A Real TTY

## Status

- plan-ready

## Goal

Restore `symphony factory attach` on macOS when the operator launches it from a real interactive terminal, while preserving the existing detached-worker safety contract: the full-screen TUI appears, `Ctrl-C` exits the foreground attach client only, and the detached factory stays alive.

## Scope

- fix the macOS-specific attach launch path in [`src/cli/factory-attach.ts`](../../../src/cli/factory-attach.ts)
- keep the existing single-session preflight and local-detach semantics from issue `#232`
- add regression coverage for the broken macOS real-TTY launch contract
- update operator-facing docs only where they need to clarify host limitations or the repaired macOS path

## Non-Goals

- redesigning `factory attach` UX or adding richer attach shortcuts
- changing `factory watch`, `factory status`, detached startup, or GNU Screen lifecycle policy
- changing tracker, orchestrator, workspace, or runner contracts
- introducing a new hosted terminal service or broad cross-platform terminal abstraction
- broadening this slice into Linux attach changes unless a shared helper seam clearly reduces risk without expanding review surface

## Current Gaps

- the current attach broker validates that the parent process has interactive `stdin`/`stdout`, but the macOS launch path then spawns `/usr/bin/script` with piped stdio
- on macOS, `/usr/bin/script` expects terminal-backed descriptors and exits immediately with `tcgetattr/ioctl: Operation not supported on socket` before it can broker the `screen -x` attach
- the existing unit coverage asserts the current macOS argv shape but does not lock the real-TTY descriptor contract that actually regressed
- operator docs describe `factory attach` as supported on macOS, but the implementation currently violates that contract

## Decision Notes

- Keep this issue inside the existing attach broker seam from [`docs/plans/232-safe-full-tui-attach/plan.md`](../232-safe-full-tui-attach/plan.md). This is a launch-transport regression, not a reason to reopen detached-runtime architecture.
- Prefer the smallest host-integration change that gives the macOS helper the terminal boundary it requires while keeping local detach ownership in Symphony code.
- If the repaired macOS path needs a slightly different child-launch contract than Linux, isolate that difference behind the existing attach-launch helper instead of spreading platform branches through attach policy code.
- Add tests for launch semantics, not only command argv strings, so future refactors cannot silently reintroduce the same descriptor mismatch.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in [`docs/architecture.md`](../../architecture.md).

- Policy Layer
  - belongs: the repo-owned rule that `factory attach` must stay a safe brokered attach path and must not stop the detached worker on local client exit
  - does not belong: OS-specific fd wiring or `script` invocation details
- Configuration Layer
  - belongs: no new user-facing workflow settings for this fix; the attach contract remains fixed runtime behavior
  - does not belong: terminal transport behavior hidden behind `WORKFLOW.md`
- Coordination Layer
  - belongs: attach preflight still resolves exactly one healthy detached target and preserves the existing local-detach contract
  - does not belong: orchestrator retries, reconciliation, leases, continuations, or tracker handoff policy
- Execution Layer
  - belongs: launching the local attach child with the terminal contract macOS requires, plus preserving input/detach/cleanup behavior
  - does not belong: workspace preparation or runner lifecycle changes
- Integration Layer
  - belongs: host-specific macOS attach-helper launch details and any small helper extraction required to keep that behavior testable
  - does not belong: tracker transport/normalization/policy or unrelated Screen management
- Observability Layer
  - belongs: explicit operator-facing failure messages and docs that keep supported attach behavior truthful on macOS
  - does not belong: status snapshot schema changes or TUI redesign

## Architecture Boundaries

### CLI / attach policy seam

Belongs here:

- interactive-terminal preflight
- detached-session resolution
- local detach semantics and final error shaping

Does not belong here:

- platform-specific fd juggling spread across policy branches
- detached runtime lifecycle management beyond current attach preflight

### Host integration seam

Belongs here:

- platform-specific child-launch configuration for macOS versus Linux
- any small typed launch contract needed to express tty-backed versus piped descriptors
- wrapping host launch errors in operator-readable attach failures

Does not belong here:

- attach-session selection policy
- tracker or orchestrator concerns

### Docs / observability seam

Belongs here:

- keeping README and operator guidance accurate about `factory attach` on macOS
- documenting any truly unavoidable remaining terminal limitation discovered during implementation

Does not belong here:

- inventing new operator procedure outside the supported factory-control commands

## Slice Strategy And PR Seam

Land one reviewable PR focused on the attach-launch seam:

1. tighten the macOS attach child launch contract
2. add regression tests that model the real-TTY requirement
3. update docs only where the repaired behavior or any remaining limitation needs to be stated explicitly

Deferred from this PR:

- replacing `script` or `screen`
- broad attach-client refactors unrelated to the macOS regression
- new platform support beyond the current macOS/Linux contract

This stays reviewable because it is limited to the attach broker, its host-launch helper, focused tests, and small docs updates. It does not mix tracker edges, orchestrator state, or detached startup behavior.

## Attach Launch State Model

This issue does not change the detached factory runtime state machine. It narrows the attach-client launch sub-state that is already process-local.

### States

1. `preflight`
   - validate interactive parent terminal and resolve one healthy detached target
2. `launching`
   - construct the platform-specific attach child transport
3. `attached`
   - the brokered child is running and the foreground TUI is visible
4. `detaching`
   - the local client exits on `Ctrl-C`, signal, or normal child completion
5. `detached`
   - the local terminal is restored and the detached worker remains alive when expected
6. `attach-failed`
   - preflight, launch, or cleanup failed with an explicit operator-facing error

### Allowed transitions

- `preflight -> launching`
- `preflight -> attach-failed`
- `launching -> attached`
- `launching -> attach-failed`
- `attached -> detaching`
- `detaching -> detached`
- `attached -> attach-failed`

### Contract rules

- macOS launch must give the helper the real terminal boundary it requires
- local detach still belongs to Symphony, not raw `screen -r`
- terminal cleanup remains mandatory on both success and failure paths

## Failure-Class Matrix

| Observed condition | Local facts available | Detached-control facts available | Expected decision |
| --- | --- | --- | --- |
| macOS operator launches from a real TTY | interactive `stdin`/`stdout`, supported platform | one healthy detached session | start the attach child with tty-compatible macOS launch wiring and show the full TUI |
| macOS helper launch uses pipe-only descriptors again | interactive parent TTY, child exits immediately with `tcgetattr/ioctl` failure | detached session still healthy | fail clearly, cover with regression tests, do not stop the worker |
| attach target is stopped or degraded | selected workflow path, local terminal | stopped/degraded control snapshot | keep current explicit preflight failure; do not attempt attach |
| operator presses `Ctrl-C` while attached | local detach byte/signal path observed | detached session otherwise healthy | exit the foreground client and leave the detached runtime alive |
| terminal restore fails after a safe detach | local cleanup error | detached worker may still be healthy | report degraded local cleanup clearly while prioritizing worker safety |

## Storage / Persistence Contract

- no new durable runtime files
- no tracker-side state changes
- no workflow/config surface changes
- regression evidence lives in unit and integration tests only

## Observability Requirements

- attach failures on macOS must remain explicit and actionable
- docs must not claim broader macOS support than the implementation actually provides
- tests must keep proving that local client exit does not call into factory stop behavior

## Implementation Steps

1. Update the attach child launch helper so the macOS path satisfies `/usr/bin/script`'s terminal-descriptor expectations without weakening the existing local-detach contract.
2. If needed, factor the launch configuration into a small typed helper so macOS-specific stdio behavior stays isolated from attach policy.
3. Extend unit tests around [`src/cli/factory-attach.ts`](../../../src/cli/factory-attach.ts) to cover the macOS launch contract, not only argv assembly.
4. Add or extend higher-level CLI coverage if needed to lock the repaired macOS path against regressions that pure helper tests would miss.
5. Update [`README.md`](../../../README.md) and/or [`docs/guides/operator-runbook.md`](../../../docs/guides/operator-runbook.md) only if implementation reveals a remaining host limitation or a clearer wording is needed.

## Tests And Acceptance Scenarios

### Unit tests

- macOS attach launch config gives the helper the tty-backed descriptor shape it requires
- Linux launch config remains unchanged unless a shared helper extraction requires a harmless representation change
- attach still intercepts local detach and does not forward `Ctrl-C` in a way that stops the detached worker
- attach still restores terminal state on normal child exit and local detach paths

### Integration / realistic harness tests

- a mocked healthy detached session can still be attached through the broker after the macOS launch-path change
- a launch failure in the attach child still surfaces as a local attach failure without changing detached factory state

### Acceptance scenarios

1. Given a healthy detached factory on macOS and a real interactive terminal, when the operator runs `pnpm tsx bin/symphony.ts factory attach`, then the full-screen TUI appears instead of failing with `tcgetattr/ioctl`.
2. Given the operator is attached through `factory attach` on macOS, when they press `Ctrl-C`, then the attach client exits and `factory status` still reports the detached runtime alive.
3. Given detached control is stopped or degraded, when the operator runs `factory attach`, then the command still refuses attach with the existing explicit guidance.

## Exit Criteria

- macOS `factory attach` no longer fails from the current real-TTY launch regression
- regression tests cover the macOS descriptor contract that broke
- existing attach safety semantics remain intact
- relevant local checks for the touched seam pass

## Deferred To Later Issues Or PRs

- replacing the current `script`/`screen` attach stack
- richer attach controls beyond safe detach
- any broader terminal portability work outside the macOS regression
