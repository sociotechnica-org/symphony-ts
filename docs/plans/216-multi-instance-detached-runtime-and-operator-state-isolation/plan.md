# Issue 216 Plan: Multi-Instance Detached Runtime And Operator-State Isolation

## Status

- plan-ready

## Goal

Make concurrent detached local Symphony instances safe by isolating detached-session identity, detached-control lookups, and operator-local generated state per selected instance.

This slice should finish the local multi-instance seam started by `#214` and `#215`: instance-rooted runtime paths already exist, and CLI commands can already target an explicit `WORKFLOW.md`; now the detached runtime and operator loop must stop assuming there is only one global detached session name or one shared repo-root operator scratch area.

## Scope

- define one deterministic instance-scoped identity contract for detached session naming and operator-local generated state
- make `factory start|stop|restart|status|watch` use the selected instance's detached session identity instead of the global `symphony-factory` constant
- make detached control inspection and stop logic isolate sessions by the targeted instance so concurrent detached runtimes do not collide
- move checked-in operator-loop generated state from one shared `.ralph/` namespace to per-instance generated paths while preserving the same operator features
- update operator prompt/skill/docs so the selected instance and its operator-local paths are explicit
- add focused unit, integration, and end-to-end coverage for two instances running or being supervised concurrently from the same engine checkout

## Non-goals

- tracker transport, normalization, or lifecycle policy changes
- cross-instance queue coordination, leases, or same-tracker ownership election
- orchestrator retry, continuation, reconciliation, or landing-state redesign
- changing the instance-rooted runtime layout from `#214`
- introducing a second instance selector beyond the `--workflow` contract from `#215`
- redesigning the operator workflow itself beyond isolating its generated local state
- changing the detached runtime checkout location from `<instance-root>/.tmp/factory-main`

## Current Gaps

- `src/cli/factory-control.ts` hardcodes one detached session name, `symphony-factory`, so concurrent detached instances can match and stop each other's screen sessions
- detached-control inspection currently filters `screen -ls` output only by that global name, so status and stop operations cannot distinguish instances safely
- the checked-in operator loop writes lock files, status snapshots, logs, and the scratchpad into one repo-root `.ralph/` namespace, so two operator loops pointed at different instances can overwrite each other's local state
- the operator prompt and skill still describe `.ralph/operator-scratchpad.md` as a single persistent notebook rather than an instance-scoped one
- current tests lock explicit workflow selection from `#215`, but they do not prove that two detached instances can run concurrently without screen-session or operator-state collisions
- docs describe instance-owned `.tmp/` and `.var/` paths, but the detached-session and operator-local state contracts still imply one global local instance

## Decision Notes

- Keep one deterministic instance identity source rather than separate ad hoc naming helpers in factory control and the operator loop.
- Derive detached session identity and operator-local state paths from the resolved selected instance, not from caller `cwd` and not from the engine checkout alone.
- Prefer deterministic, inspectable names over random suffixes. Operators should be able to predict which session and operator-state directory belong to which instance.
- Keep operator-local state separate from instance-owned runtime state. `.tmp/` and `.var/` stay instance-owned runtime surfaces; `.ralph/` remains operator-local generated state, but it must be partitioned per targeted instance.
- Keep this issue on the local-isolation seam only. Do not broaden it into tracker-side concurrency or distributed runtime coordination.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that detached session identity and operator-local generated state are scoped to one selected instance
  - belongs: the rule that deterministic instance identity, not a global repo-root singleton, owns detached runtime/control naming
  - does not belong: `screen` process inspection, shell lock creation, or filesystem writes
- Configuration Layer
  - belongs: deriving a reusable instance identity value and any instance-scoped generated-path helpers from the selected workflow/instance contract
  - does not belong: screen launch/stop behavior or operator wake-up policy
- Coordination Layer
  - belongs: selecting the targeted instance's detached session identity and operator-state root consistently across `factory` commands and the operator loop
  - does not belong: tracker queue arbitration or retry-state changes
- Execution Layer
  - belongs: launching, stopping, and inspecting detached runtime sessions under the targeted instance's session name
  - does not belong: tracker lifecycle semantics, review-loop policy, or operator scratchpad content rules
- Integration Layer
  - belongs: shell/operator-loop integration that reads and writes instance-scoped generated files and passes the selected workflow path through to factory-control commands
  - does not belong: tracker API changes or mixed tracker/runtime policy
- Observability Layer
  - belongs: surfacing instance-scoped session names, selected workflow paths, and operator-state locations clearly in control/status output and docs
  - does not belong: inventing detached-session names independently of the shared instance identity contract

## Architecture Boundaries

### Policy / local multi-instance contract

Belongs here:

- the rule that one selected instance gets one deterministic detached session identity
- the rule that operator-local generated state is partitioned per selected instance

Does not belong here:

- raw `screen -ls` parsing
- shell lock acquisition details

### Configuration / instance identity helpers

Belongs here:

- deriving a stable instance key from resolved instance facts
- deriving detached session names and operator-state paths from that key
- validating any length/character constraints needed by downstream shells or `screen`

Does not belong here:

- launching the detached runtime
- deciding when to restart or stop the runtime

### Detached factory control

Belongs here:

- resolving factory paths plus detached session identity from the selected instance
- filtering, launching, and stopping only the targeted instance's detached screen session
- preserving current single-instance ergonomics while removing cross-instance collisions

Does not belong here:

- operator scratchpad management
- tracker-side run ownership policy

### Operator loop

Belongs here:

- writing status, logs, scratchpad, and lock files under an instance-scoped operator-state root
- exposing the selected workflow and operator-state root in loop status metadata
- keeping the checked-in prompt aligned with the new instance-scoped local paths

Does not belong here:

- inventing a second instance-selection mechanism
- moving runtime-owned artifacts into operator-local storage

### Observability and docs

Belongs here:

- rendering the detached session name and selected operator-state root clearly enough for operators to diagnose which instance is being inspected
- updating README/runbook/operator-skill text so the multi-instance contract is explicit

Does not belong here:

- broad self-hosting workflow redesign
- unrelated TUI or report-schema changes

## Slice Strategy And PR Seam

This issue should land as one reviewable PR on one isolation seam:

1. define one deterministic instance identity helper
2. scope detached session naming and control inspection to that identity
3. scope checked-in operator-loop generated state to that identity
4. lock the behavior with focused tests and minimal doc updates

Deferred from this PR:

- same-tracker concurrent coordination policy across multiple instances
- remote-host or distributed detached-session naming
- per-instance operator UX beyond the generated-state partitioning needed for correctness
- broader operator dashboard aggregation across many instances

This seam is reviewable because it stays on local detached-runtime/operator isolation. It does not combine tracker edges, orchestrator retry state, or workflow-schema redesign in the same patch.

## Instance Isolation Resolution Model

This issue does not change orchestration retry or handoff states. The stateful surface here is local control/monitoring identity for a selected instance.

### States

1. `selector-resolved`
   - a command or operator loop has a concrete selected workflow path, explicit or defaulted
2. `instance-resolved`
   - the workflow path resolves to typed instance paths
3. `identity-derived`
   - deterministic detached session identity and operator-state root are derived for that instance
4. `isolated-surface-active`
   - factory control and/or operator loop read and write only the targeted instance's session and generated files
5. `identity-resolution-failed`
   - required selected-instance facts cannot produce valid identity/path outputs

### Allowed transitions

- `selector-resolved -> instance-resolved`
- `instance-resolved -> identity-derived`
- `identity-derived -> isolated-surface-active`
- `selector-resolved -> identity-resolution-failed`
- `instance-resolved -> identity-resolution-failed`
- `identity-derived -> identity-resolution-failed`

### Contract rules

- the selected workflow path remains the authoritative instance selector
- detached session naming must be deterministic per instance and unique across distinct instance roots on the same host
- detached control inspection/stop logic must only match the targeted instance's session identity
- operator-local generated files must be partitioned by targeted instance, not shared globally across all instances in one engine checkout
- runtime-owned `.tmp/` and `.var/` files remain instance-owned runtime state; operator-local generated files stay separate from them

## Failure-Class Matrix

| Observed condition                                                              | Local facts available                                       | Normalized instance facts available             | Expected decision                                                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Two instances launch detached runtimes from the same engine checkout            | two selected workflow paths                                 | two distinct instance roots and identity values | each instance gets a distinct detached session name; both can run concurrently              |
| `factory status --workflow <instance-a>` runs while instance B is also detached | selected workflow path, all `screen -ls` output             | instance A identity                             | inspect only A's matching session; do not report B as degraded noise                        |
| `factory stop --workflow <instance-a>` runs while instance B is healthy         | selected workflow path, all live sessions/processes         | instance A identity                             | stop only A's detached session and descendants; leave B untouched                           |
| legacy global `symphony-factory` session exists from older code                 | matching sessions include legacy/global and/or scoped names | targeted instance identity                      | surface clear degraded or migration-safe behavior without silently killing another instance |
| two operator loops target different instances from the same engine checkout     | same operator repo root, two selected workflow paths        | two distinct operator-state roots               | lock/status/log/scratchpad files do not collide; each loop reports its own state            |
| operator loop omits `--workflow` inside an instance root                        | caller `cwd`                                                | discovered selected instance and identity       | preserve current local-default behavior but still write per-instance operator state         |
| provided workflow path is invalid                                               | workflow path only                                          | none                                            | fail clearly before reading or writing session/operator files for any other instance        |

## Storage / Persistence Contract

- detached runtime snapshots remain under the selected instance's existing instance-owned temp area:
  - `<instance-root>/.tmp/status.json`
  - `<instance-root>/.tmp/startup.json`
  - `<instance-root>/.tmp/factory-main`
- detached session identity becomes a deterministic derived value of the selected instance rather than one global constant
- operator-local generated state stays under the operator checkout's `.ralph/`, but moves under an instance-scoped root such as:
  - `<operator-repo-root>/.ralph/instances/<instance-key>/status.json`
  - `<operator-repo-root>/.ralph/instances/<instance-key>/status.md`
  - `<operator-repo-root>/.ralph/instances/<instance-key>/operator-scratchpad.md`
  - `<operator-repo-root>/.ralph/instances/<instance-key>/logs/`
  - `<operator-repo-root>/.ralph/instances/<instance-key>/operator-loop.lock`
- no tracker-side persistence changes are introduced in this issue

## Observability Requirements

- `factory status` and related JSON output should expose the resolved detached session name for the targeted instance
- operator-loop status JSON/Markdown should expose the selected workflow path and the instance-scoped operator-state root
- degraded-control messages should stay explicit when collisions or legacy/global session leftovers are detected
- docs should explain the difference between instance-owned runtime state and operator-local generated state

## Implementation Steps

1. Add a small shared instance-identity helper that derives:
   - a stable instance key from resolved instance facts
   - the detached session name for that instance
   - the operator-state root for that instance
2. Refactor `src/cli/factory-control.ts` so `resolveFactoryPaths()` exposes the targeted session identity and all start/status/stop/watch flows use that scoped name instead of the global constant.
3. Update detached-control inspection and stop logic so session filtering is scoped to the targeted instance and collision/degraded reporting remains accurate.
4. Refactor `skills/symphony-operator/operator-loop.sh` to derive or receive the targeted instance identity and write lock/status/log/scratchpad files under an instance-scoped generated directory.
5. Update `skills/symphony-operator/operator-prompt.md`, `skills/symphony-operator/SKILL.md`, `README.md`, and the operator docs to describe:
   - instance-scoped detached sessions
   - instance-scoped operator generated state
   - the continued separation between instance-owned `.tmp/.var` and operator-local `.ralph`
6. Add regression tests for concurrent detached-control selection and concurrent operator-loop state isolation.

## Tests And Acceptance Scenarios

### Unit tests

- instance-identity helper derives stable distinct identity values for two different instance roots
- factory control derives a distinct detached session name per selected instance
- `factory status` / `factory stop` only match sessions for the targeted instance when another instance's session is also present
- operator-loop path derivation produces distinct lock/status/log/scratchpad roots for two selected workflow paths
- operator-loop default selection still resolves one instance cleanly when launched from inside an instance root

### Integration tests

- two temp instances can each run factory-control inspection against distinct scoped sessions without cross-reporting
- stopping one targeted instance leaves the other instance's mocked detached session alive
- operator-loop `--once` run for instance A and instance B publishes state into separate per-instance generated directories under `.ralph/instances/`

### End-to-end acceptance scenarios

1. Given two target repositories with their own `WORKFLOW.md` files, when both detached factories are started from one engine checkout, then each uses a different deterministic screen session name and both remain inspectable.
2. Given both detached factories are running, when an operator runs `symphony factory stop --workflow <instance-a>/WORKFLOW.md`, then only instance A stops and instance B remains healthy.
3. Given two operator loops target two different instances from one engine checkout, when each writes status/log/scratchpad state, then the files remain isolated and inspectable per instance.
4. Given the operator inspects one selected instance, when control output is rendered, then the session name and operator-local state path make it clear which instance is being observed.

## Exit Criteria

- detached factory sessions are deterministic and instance-scoped instead of globally named
- detached-control inspection/start/stop/watch isolate the targeted instance cleanly when multiple instances exist
- checked-in operator-loop generated state is instance-scoped and no longer assumes one shared repo-root singleton
- docs explain the multi-instance local isolation contract clearly
- focused tests cover concurrent detached-control and operator-state isolation scenarios

## Deferred To Later Issues Or PRs

- cross-instance coordination against the same tracker queue
- distributed or multi-host detached-session identity
- aggregated multi-instance operator dashboards
- migration tooling beyond the minimal compatibility handling needed for this slice
