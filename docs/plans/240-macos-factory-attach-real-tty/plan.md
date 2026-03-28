# Issue 240 Plan: Fix macOS Factory Attach From A Real TTY

## Status

- plan-ready

## Goal

Fix `symphony factory attach` on macOS when the command is launched from a real interactive terminal.

The existing attach contract from issue `#232` should remain intact:

- `factory status --json` stays the canonical detached-runtime read surface
- `factory watch` stays the supported read-only live monitor
- `factory attach` remains the supported richer foreground TUI recovery path
- local `Ctrl-C` still exits the attach client without stopping the detached factory

## Scope

- correct the macOS attach launch path so `/usr/bin/script` talks to the operator's real terminal device instead of piped stdio
- keep Linux attach behavior working and unchanged unless a small shared helper refactor is needed for a clean seam
- preserve the existing attach preflight and local-detach semantics
- add focused regression tests for the macOS launch contract and any attach-client behavior that changes as a result
- update operator-facing docs only if the implementation or any remaining limitation needs to be clarified

## Non-goals

- redesigning the attach UX, terminal shortcut model, or TUI layout
- changing `factory watch`, detached startup, or factory-control status semantics
- replacing GNU Screen or the `script` helper
- changing orchestrator retry, continuation, reconciliation, lease, or handoff behavior
- broadening this issue into cross-platform terminal abstraction work beyond what the macOS fix requires

## Current Gaps

- [`src/cli/factory-attach.ts`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/workspaces/sociotechnica-org_symphony-ts_240/src/cli/factory-attach.ts) validates that the parent process has TTY stdin/stdout, then launches the macOS `script` helper with piped stdio
- on macOS, `/usr/bin/script` expects a real terminal-backed stdio boundary and fails early with `tcgetattr/ioctl: Operation not supported on socket`
- the current unit coverage checks macOS command construction, but it does not lock the actual child-launch stdio contract that caused this regression
- the supported docs promise `factory attach` as the safe full-TUI recovery path, but the current macOS implementation breaks that promise in real terminal use

## Decision Notes

- Keep the fix inside the existing attach broker seam instead of introducing a second macOS-only operator path
- Prefer a small, explicit launch-contract split over burying host-specific stdio choices inline in one spawn call
- Keep the user-visible contract stable: this issue is a transport correction, not an attach-policy redesign
- If the safest macOS implementation needs to let the child own the inherited terminal directly, keep the repo-owned local-detach safety semantics explicit in tests before and after that handoff

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping from [`docs/architecture.md`](/Users/jessmartin/Documents/code/symphony-ts/.tmp/workspaces/sociotechnica-org_symphony-ts_240/docs/architecture.md).

- Policy Layer
  - belongs: the repo-owned rule that `factory attach` must work from a normal interactive terminal on supported hosts and must keep `Ctrl-C` scoped to the attach client
  - does not belong: per-platform `spawn()` stdio tuples or `script` argv details
- Configuration Layer
  - belongs: none for this slice unless a tiny internal typed launch mode is needed inside CLI code
  - does not belong: new `WORKFLOW.md` settings or persistent operator configuration
- Coordination Layer
  - belongs: unchanged attach preflight and the rule that the command still targets one healthy selected detached session
  - does not belong: orchestrator runtime-state changes, retry policy, or recovery redesign
- Execution Layer
  - belongs: the attach client process boundary, terminal-mode handling, local input/output forwarding, and the platform-specific child-launch contract
  - does not belong: workspace lifecycle or runner behavior changes
- Integration Layer
  - belongs: host-specific interaction with `script` and `screen`, including macOS-specific stdio requirements
  - does not belong: tracker transport, normalization, or tracker lifecycle policy
- Observability Layer
  - belongs: clear attach failure messages and any doc note needed to describe supported terminal behavior precisely
  - does not belong: snapshot-schema changes or unrelated TUI/status-surface work

## Architecture Boundaries

### CLI / attach-command seam

Belongs here:

- `factory attach` parsing and dispatch
- attach preflight against detached control state
- selection of the attach-launch path for the current host

Does not belong here:

- broad terminal-abstraction rewrites
- tracker or orchestrator policy

### Attach broker seam

Belongs here:

- local detach behavior and terminal restoration rules
- child launch ownership behind a focused helper or launch contract
- the minimal branching required to support macOS without regressing Linux

Does not belong here:

- detached lifecycle management outside attach
- status rendering or factory watch polling logic

### Host integration seam

Belongs here:

- the exact `script` and `screen` invocation per platform
- the stdio mode required by each host helper
- actionable errors when the helper cannot be launched

Does not belong here:

- attach policy
- tracker integration

### Tracker / workspace / runner / orchestrator seams

Untouched for this slice:

- tracker adapters should not learn about terminal attach behavior
- workspace code should not absorb attach transport logic
- runners should not gain attach-specific behavior
- orchestrator state machines remain unchanged

## Slice Strategy And PR Seam

This issue should land as one narrow PR on the attach transport boundary:

1. make the attach child-launch contract explicit
2. fix the macOS launch path to use a real terminal-backed stdio boundary
3. keep existing attach semantics intact
4. add regression coverage for the broken macOS path

Deferred from this PR:

- larger attach UX refinements
- backend replacement for `script` or Screen
- broader cross-platform PTY abstraction cleanup beyond the minimum seam needed here

This remains reviewable because it stays inside one CLI/attach module plus focused tests and any minimal doc clarification. It does not mix tracker work, orchestrator policy, or TUI redesign.

## Runtime State Model

This issue does not change the detached factory runtime state machine from `#232`. The attach-client state model remains the same; only the host-specific child-launch transition from `attach-ready -> attaching` changes on macOS.

### States

1. `preflight`
2. `attach-ready`
3. `attaching`
4. `attached`
5. `detaching`
6. `detached`
7. `attach-failed`

### Allowed transitions

- `preflight -> attach-ready`
- `preflight -> attach-failed`
- `attach-ready -> attaching`
- `attaching -> attached`
- `attaching -> attach-failed`
- `attached -> detaching`
- `detaching -> detached`
- `attached -> attach-failed`

### Contract rule affected by this issue

- on macOS, the transition from `attach-ready` to `attaching` must launch the local attach helper with a real terminal-backed stdio boundary so the attach session can actually enter `attached`

## Failure-Class Matrix

| Observed condition | Local facts available | Detached-control facts available | Expected decision |
| --- | --- | --- | --- |
| macOS operator launches `factory attach` from a real TTY | `stdin.isTTY=true`, `stdout.isTTY=true`, platform `darwin` | one healthy detached session | launch the attach helper with terminal-backed stdio and enter attached mode |
| macOS attach helper is launched with piped stdio | real TTY at parent, helper exits immediately with `tcgetattr/ioctl` failure | one healthy detached session remains | treat as a bug to remove; regression tests should prevent this launch shape |
| Linux operator launches `factory attach` from a real TTY | parent TTY, platform `linux` | one healthy detached session | keep existing supported attach path working |
| attach preflight reports stopped or degraded control | parent TTY may be healthy | stopped or degraded detached control | fail clearly before any helper launch |
| operator presses `Ctrl-C` while attached | local interrupt byte or signal received | detached session remains healthy | detach the client only and keep the factory alive |
| attach helper is unavailable | launch error such as `ENOENT` or `ENOEXEC` | detached session may still be healthy | fail clearly with actionable local-host guidance |

## Storage / Persistence Contract

- no new durable files or tracker state are introduced
- no changes to detached status snapshots are required
- any launch-mode distinction stays process-local to `factory attach`

## Observability Requirements

- attach failures must stay explicit and actionable
- the broken macOS `tcgetattr/ioctl` launch path should be covered by tests so it does not reappear silently
- docs should continue to position `factory attach` as the safe full-TUI recovery path, with any remaining terminal limitations called out only if real and unavoidable

## Implementation Steps

1. Refactor the attach child-launch path so platform-specific launch configuration is explicit and testable.
2. Change the macOS attach launch contract so the `script` helper inherits or otherwise receives a real terminal-backed stdio boundary instead of piped sockets.
3. Preserve the existing attach preflight, local detach, and terminal restoration behavior unless the implementation requires a small targeted adjustment.
4. Add regression tests that prove the macOS path no longer uses the broken piped launch shape and that Linux behavior remains covered.
5. Update docs if the implementation changes any operator-visible limitation or guarantee.

## Tests And Acceptance Scenarios

### Unit tests

- attach launch configuration uses the macOS-specific real-terminal stdio contract
- Linux attach launch configuration remains on its expected launch contract
- attach preflight still rejects stopped or degraded control before launch
- local `Ctrl-C` handling still exits the attach client without invoking factory stop behavior

### Integration tests

- a mocked macOS attach launch path exercises the real-terminal launch contract without requiring a live detached runtime
- attach failures still surface clear operator messages when launch prerequisites are missing

### End-to-end acceptance scenarios

1. Given a healthy detached factory and a normal macOS terminal session, when the operator runs `pnpm tsx bin/symphony.ts factory attach`, then the full-screen TUI attaches successfully.
2. Given the operator is attached through `factory attach` on macOS, when they press `Ctrl-C`, then the attach client exits and a follow-up `factory status` still shows the detached runtime alive.
3. Given attach preflight is stopped or degraded, when the operator runs `factory attach`, then the command fails before launch with the existing clear control-state guidance.

## Exit Criteria

- macOS `factory attach` works from a real interactive terminal
- the broken piped-stdio launch shape is removed from the macOS attach path
- local-detach safety semantics remain intact
- regression tests cover the macOS launch contract
- any operator-visible limitation or guarantee change is documented

## Deferred

- attach UX redesign
- Screen replacement
- broader PTY abstraction cleanup
- unrelated detached-runtime observability work
