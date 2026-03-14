# Issue 136 Plan

## Summary

Package the operator wake-up loop as a supported, versioned repo tool instead of a script living under ignored `.ralph/`, while keeping `.ralph/` reserved for local/generated operator state.

Plan status: plan-ready

## Goal

Give contributors one discoverable, reviewable entry point for running the repo's operator loop from a clean clone without learning a force-add exception or treating `.ralph/` as partly-versioned scratch space.

## Scope

- choose and document the supported home for the operator loop
- move or replace the current loop with a versioned entry point in that supported home
- make the commit-vs-local boundary explicit between durable operator tooling, durable operator guidance, and local/generated operator state
- keep the loop compatible with the current detached `symphony factory` control surface and multi-runner runtime model
- update the operator skill, README, and self-hosting docs to point to the supported entry point

## Non-Goals

- changing factory runtime behavior in `src/orchestrator/`, `src/runner/`, `src/tracker/`, or `src/cli/`
- redesigning the operator workflow beyond packaging/discovery of the existing wake-up loop
- making the operator loop a general-purpose product CLI command for all Symphony repos
- changing tracker lifecycle policy, retries, watchdog logic, or landing semantics
- versioning `.ralph/` runtime notes, logs, or generated status artifacts

## Current Gaps

- the issue describes a durable loop script at `.ralph/ralph-loop.sh`, but `.ralph/` is ignored and not present in a clean clone, so the supported operator entry point is not discoverable from the checked-out repo
- the current checked-in operator surface is split awkwardly between durable guidance in `skills/symphony-operator/SKILL.md` and implied local-only automation in `.ralph/`
- `.gitignore` treats all of `.ralph/` as local-only, but repo policy/docs do not yet define a first-class checked-in home for operator-loop automation
- the docs describe detached factory control and watch commands, but they do not expose one durable command for the higher-level operator wake-up loop itself

## Option Evaluation

### Option 1: version the loop under `skills/symphony-operator/`

Pros:

- colocates durable operator behavior and durable operator tooling
- matches the existing repo split where `skills/` holds reusable operator guidance
- keeps the tool obviously repo-local rather than implying it is part of the product CLI
- lets docs and the skill point to one adjacent entry point

Cons:

- `skills/` is guidance-first, so a scripted entry point there needs clear documentation to avoid looking like hidden prompt state

### Option 2: version the loop under `bin/`, `scripts/`, or `tools/operator/`

Pros:

- makes tooling look more conventional to contributors
- can separate executable code from skill prose cleanly

Cons:

- weakens the existing adjacency between operator guidance and operator automation
- introduces a new top-level surface for a repo-specific operator helper even though the repo already has a durable operator home

### Option 3: replace the loop with a first-class CLI entry point

Pros:

- yields the cleanest command UX if the operator loop is promoted to a product-level contract

Cons:

- broadens the review surface into `src/cli/` and product command design
- risks mixing repo-local operator automation with general runtime control
- is unnecessary for this packaging/discovery slice if the current shell-based loop can be versioned cleanly

### Proposed Direction

Land the loop as a versioned script under `skills/symphony-operator/`, then expose a simple documented repo-root invocation for it, likely through a package script alias plus direct script path documentation.

Rationale:

- this keeps durable operator guidance and durable operator tooling adjacent
- it avoids widening the seam into product CLI design
- it keeps `.ralph/` purely local/generated
- it satisfies the issue's requirement that the supported loop be reviewable and discoverable from a clean clone

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the repo-owned rule that operator-loop guidance and entry points are versioned, discoverable, and separate from local-only runtime state
  - does not belong: changing issue lifecycle, plan review policy, or landing policy
- Configuration Layer
  - belongs: any explicit environment variables or path contracts the loop needs to locate local-only state or tune cadence
  - does not belong: hidden author-specific paths or shell-profile assumptions baked into the versioned tool
- Coordination Layer
  - belongs: the loop's wake-up cadence, lock/lease behavior for one local operator loop instance, and its interaction boundary with `symphony factory status|watch|start`
  - does not belong: becoming a second scheduler or reimplementing orchestrator state transitions
- Execution Layer
  - belongs: the concrete wrapper that launches the operator session and invokes repo-owned commands
  - does not belong: runner semantics, workspace orchestration, or tracker mutations that belong in the factory runtime
- Integration Layer
  - belongs: shell and `gh` interactions used by the loop, if any, behind a stable repo-owned contract
  - does not belong: coupling the loop to a single agent/provider assumption when the factory runtime is multi-runner
- Observability Layer
  - belongs: clear placement of local/generated operator artifacts such as `.ralph/status.*`, loop logs, and scratch notes
  - does not belong: mixing those generated artifacts into the same versioned directory as the durable tool

## Architecture Boundaries

- `skills/symphony-operator/SKILL.md` remains the durable guidance layer.
- The packaged loop becomes durable tooling adjacent to that skill, not hidden under `.ralph/`.
- `.ralph/` remains local/generated state only: operator notebook, generated status, logs, temp cycle files, and any per-run scratch artifacts.
- The product CLI under `bin/` and `src/cli/` remains focused on factory/runtime control, not repo-specific operator wake-up automation.
- The implementation should avoid new assumptions about `codex` as the only healthy runtime; the loop should continue to supervise the factory through repo-owned control surfaces and runner-neutral docs.

## Slice Strategy And PR Seam

Keep this as one packaging-and-discovery PR:

1. add the plan for issue `#136`
2. add the versioned operator-loop entry point in its supported repo-owned home
3. update docs and skill guidance to point at that entry point
4. make the `.ralph/` boundary explicit as local/generated-only

Why this fits in one reviewable PR:

- it stays in repo-local tooling, package metadata, ignore/docs, and operator guidance
- it does not change factory runtime behavior or tracker/orchestrator contracts
- it preserves the seam established by issue `#134`, which explicitly deferred this packaging follow-up

## Runtime State Model

This issue does not change the factory runtime state machine, but the packaged operator loop itself is stateful enough to name a minimal cycle model.

States:

1. `idle`: loop not running
2. `acquiring-lock`: startup path attempting to claim the local loop lock
3. `sleeping`: loop is healthy and waiting for the next wake-up time
4. `retrying`: the last cycle failed and the loop is waiting for the next retry interval
5. `acting`: loop is invoking the operator command for one cycle
6. `recording`: loop is writing local-only status artifacts or logs
7. `failed`: loop cannot continue because setup, locking, or command execution failed
8. `stopping`: loop received shutdown and is releasing local state cleanly

Allowed transitions:

- `idle -> acquiring-lock`
- `acquiring-lock -> sleeping`
- `acquiring-lock -> failed`
- `sleeping -> acting`
- `retrying -> acting`
- `acting -> recording`
- `recording -> sleeping`
- `failed -> retrying`
- `acting -> failed`
- `recording -> failed`
- `sleeping -> stopping`
- `retrying -> stopping`
- `acting -> stopping`
- `recording -> stopping`
- `stopping -> idle`

Notes:

- the lock is local operator-loop coordination only; it must not be treated as factory ownership or tracker ownership
- generated artifacts remain best-effort observability aids, not the system of record for runtime state
- repo/factory/issue inspection happens inside the launched operator session; `.ralph/status.json` surfaces the loop's coarse outer cycle states rather than an internal inspection subphase

## Failure-Class Matrix

| Observed condition                                   | Local facts available                                     | Expected decision                                                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| packaged loop entry point missing or not executable  | clean clone, repo files present or validation fails       | fail clearly during setup and document the supported invocation                                                                                            |
| second loop start attempted while local lock is held | lockfile exists and owner appears live                    | exit with a clear "already running" message rather than racing                                                                                             |
| stale loop lock found                                | lockfile exists but owner is dead/unreadable              | clear or replace the stale lock using repo-owned rules; do not require manual `.ralph/` archaeology                                                        |
| operator cycle command fails                         | repo commands or `gh` step exits non-zero                 | record failure in local status/log artifacts, expose a visible `retrying` wait state before the next cycle, and do not mutate factory policy in this issue |
| detached factory is stopped or degraded              | `symphony factory status --json` reports stopped/degraded | surface the state in the loop's local status output; do not invent new runtime control logic                                                               |
| `.ralph/` does not exist yet                         | clean clone or new machine                                | create only the local/generated directories/files needed at runtime; durable tooling must remain elsewhere                                                 |

## Storage And Persistence Contract

- versioned:
  - `skills/symphony-operator/` for durable guidance plus the packaged loop tool
  - package metadata or docs pointing to the supported invocation
- local/generated only:
  - `.ralph/operator-scratchpad.md`
  - `.ralph/status.json`
  - `.ralph/status.md`
  - `.ralph/logs/`
  - temp cycle files and lock files used by the operator loop

The plan should make this boundary explicit in docs and, if needed, in ignore comments or directory-level README guidance.

## Observability Requirements

- the supported operator entry point must be named in checked-in docs
- local/generated status artifacts must still land under `.ralph/` or the documented equivalent local-only area
- the packaged loop should emit actionable errors when setup, locking, or the cycle command fails
- docs should explain that `factory status` / `factory watch` remain the canonical runtime-control surfaces and that the operator loop sits above them as repo-local automation

## Implementation Steps

1. Create `docs/plans/136-package-operator-loop-tooling/plan.md` with this scope and decision record.
2. Add the packaged operator-loop script under `skills/symphony-operator/`.
3. Add the minimal repo-root invocation surface for that script, likely a `package.json` script alias.
4. Update `skills/symphony-operator/SKILL.md` so durable guidance points to the supported entry point and reserves `.ralph/` for local/generated state only.
5. Update `README.md` and `docs/guides/self-hosting-loop.md` so a new contributor can discover and run the operator-assisted flow from a clean clone.
6. Update `.gitignore` comments or adjacent docs only as needed to make the packaging boundary explicit without versioning `.ralph/`.
7. Validate the packaged entry point from the repo root and manually exercise one operator wake-up cycle against the local factory.
8. Run local QA gates for touched surfaces.
9. Self-review the diff, fix findings, then open/update the PR for `#136`.

## Tests

- shell validation of the packaged entry point from the repo root
- manual clean-clone-path validation that the documented command does not depend on `.ralph/ralph-loop.sh`
- manual one-cycle validation that generated status/log artifacts still land in `.ralph/`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

## Acceptance Scenarios

1. From a clean clone, a contributor can find the operator-loop command in checked-in docs and run the versioned entry point without learning a force-add exception.
2. After the change, the repo layout makes it obvious that `skills/symphony-operator/` is versioned and `.ralph/` is local/generated only.
3. The packaged loop still supervises the factory through the detached factory-control surface and does not assume one specific runner implementation.
4. Running one wake-up cycle still produces local operator artifacts under `.ralph/` rather than mixing them into the versioned tooling directory.
5. The final PR stays limited to operator-tooling packaging, docs, and supporting repo-owned invocation wiring.

## Exit Criteria

- one versioned, documented operator-loop entry point exists in a supported repo-owned location
- `.ralph/` is documented and treated as local/generated-only state
- operator docs and skill guidance point to the supported entry point
- the packaged loop works from the repo root with the documented command
- local QA gates pass
- PR is opened or updated against `main` and references `#136`

## Deferred

- replacing the operator loop with a first-class product CLI command
- changing factory runtime semantics, retries, reconciliation, or watchdog behavior
- broader operator dashboard or control-surface redesign
- generalizing this repo-local operator tool into a cross-repo framework

## Decision Notes

- Prefer adjacency over a new top-level tooling directory for this slice: the operator loop is a repo-local operator aid, and `skills/symphony-operator/` is already the durable home for that role.
- Keep the product CLI boundary clean: `symphony factory ...` remains the runtime-control surface, while the packaged operator loop remains a repo-owned helper layered above it.
