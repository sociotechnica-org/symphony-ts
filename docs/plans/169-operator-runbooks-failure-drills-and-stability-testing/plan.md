# Issue 169 Plan: Operator Runbooks, Failure Drills, And Stability Testing

## Status

- plan-ready

## Goal

Turn the merged Phase 6 runtime behavior into a credible day-two operating surface by adding repo-owned operator runbooks, explicit failure-drill guidance, and repeatable stability/concurrency validation. The outcome of this slice is that an operator can start, monitor, restart, diagnose, and recover the local factory from checked-in guidance and repeatable tests instead of tribal knowledge or ad hoc shell history.

This issue is the operations-and-validation seam after the underlying recovery/runtime slices. It should package the existing runtime contracts into durable guidance and realistic validation without widening into new restart, retry, watchdog, or tracker-policy implementation.

## Scope

- add a checked-in operator runbook guide for the supported local detached factory lifecycle:
  - startup and steady-state monitoring
  - safe detached watch/stop/restart flow
  - daily health checks and interpretation of `factory status` / `factory watch`
  - issue/PR handoff checkpoints operators must clear manually
- add a checked-in failure-drills guide that exercises the existing Phase 6 recovery paths intentionally:
  - detached runtime stopped or crashed
  - inherited `symphony:running` work on restart
  - stalled or watchdog-aborted runner behavior
  - retry/backoff and transient-failure posture
  - retained-failure workspace inspection and cleanup
- add repeatable repo-owned validation for operational credibility:
  - a focused automated stability/concurrency test slice over the existing mocked harness
  - contract coverage for any new operator-facing docs artifacts or command outputs introduced by this issue
- update top-level/operator-facing docs to point to the new durable runbook location instead of leaving recovery guidance scattered across `README.md`, `docs/guides/self-hosting-loop.md`, and `skills/symphony-operator/SKILL.md`
- keep the new guidance aligned with the current detached control path, restart recovery posture, retry/backoff posture, workspace retention policy, and landing/review checkpoints already implemented on `main`

## Non-Goals

- redesigning restart recovery, retry/backoff, watchdog, transient-failure, or workspace-retention policy
- changing tracker transport, normalization, or lifecycle semantics
- adding a new operator control plane, dashboard mode, or remote management system
- inventing recovery steps that bypass the supported factory-control commands
- adding real external-network chaos testing in CI
- widening this PR into unrelated docs refreshes outside the operator/runtime seam

## Current Gaps

- `README.md`, `docs/guides/self-hosting-loop.md`, and `skills/symphony-operator/SKILL.md` describe pieces of the operator flow, but there is no single checked-in runbook for normal operation and recovery
- restart recovery, watchdog recovery, retry/backoff posture, and workspace retention behavior exist in code and tests, but operators do not yet have one repo-owned guide that explains which commands to run and how to interpret the outcomes
- there is no dedicated failure-drill document that lets maintainers rehearse Phase 6 recovery behavior intentionally
- existing end-to-end coverage proves many individual recovery paths, but the repo does not yet present one named stability/concurrency validation slice tied to operator credibility
- operator knowledge still depends too much on prior issue history and adjacent plan documents rather than durable docs aimed at daily operation

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

- the supported day-two operating procedure for the local factory
- the operator decision points for plan review, landing, and recovery escalation
- the required failure-drill matrix and the rule that runbooks reflect coordination-owned truth rather than folklore

Does not belong here:

- tracker API details
- runner subprocess transport changes
- TUI implementation details beyond the supported operator interpretation

### Configuration Layer

Belongs here:

- documenting how existing workflow knobs affect operations, such as:
  - `polling.max_concurrent_runs`
  - `polling.retry.*`
  - `polling.watchdog.*`
  - `workspace.retention.*`
- any fixture-only config used by new mocked stability tests

Does not belong here:

- new durable runtime state
- operational truth encoded in docs instead of typed config/runtime state
- provider-specific recovery branching hidden in config prose

### Coordination Layer

Belongs here:

- reusing the existing runtime-state vocabulary in the runbooks and drills:
  - restart recovery posture
  - retry/backoff posture
  - watchdog recovery posture
  - awaiting-human-handoff and awaiting-landing checkpoints
- automated stability/concurrency tests that validate coordination behavior through existing public contracts

Does not belong here:

- new retry/recovery policy for this issue
- ad hoc operator-only state machines that diverge from the existing orchestrator contracts

### Execution Layer

Belongs here:

- documenting the supported detached-runtime command path and workspace inspection/cleanup flow
- mocked execution fixtures for stability testing

Does not belong here:

- new runner integrations
- new workspace lifecycle semantics
- replacing the supported control path with raw `screen`, `ps`, or `pkill` procedures

### Integration Layer

Belongs here:

- existing mocked tracker/runtime harnesses used by the new validation slice
- documenting only the current normalized GitHub-facing lifecycle where operators need it

Does not belong here:

- tracker transport refactors
- provider-specific behavior mixed into operator docs where the normalized lifecycle already exists

### Observability Layer

Belongs here:

- runbook guidance for reading `factory status`, `factory watch`, persisted status snapshots, and issue/report artifacts
- any additions to operator-facing docs that point to the canonical status and reporting surfaces
- tests that verify operator-visible status outputs or docs-linked fixtures stay aligned with the runtime

Does not belong here:

- making docs or rendered status text the source of truth for runtime policy
- UI redesign unrelated to the runbook/drill seam

## Architecture Boundaries

### `docs/guides/`

Owns:

- durable operator runbooks and failure-drill procedures
- high-signal guidance that references existing commands, statuses, and artifacts

Does not own:

- runtime truth that belongs in code/tests
- policy decisions that contradict `AGENTS.md`, `WORKFLOW.md`, or the existing orchestrator contracts

### `skills/symphony-operator/`

Owns:

- compact wake-up-loop policy and operator checkpoints
- pointers into the deeper runbook when a step needs full procedure detail

Does not own:

- the only copy of recovery instructions
- lengthy procedural guidance that belongs in durable docs

### `tests/e2e/` and supporting fixtures/helpers

Owns:

- repeatable mocked validation for the stability/concurrency seam
- realistic orchestration scenarios that exercise the documented operator expectations

Does not own:

- real external-system chaos testing
- broad unrelated coverage rewrites across all factory test suites

### `README.md` and `docs/guides/self-hosting-loop.md`

Own:

- concise navigation and entry-point guidance
- linking operators to the canonical runbook and drill docs

Do not own:

- duplicated long-form recovery procedures already captured in the new runbooks

## Layering Notes

- `config/workflow`
  - may be referenced by the runbooks and test fixtures
  - must not absorb operator-procedure prose
- `tracker`
  - remains the normalized external queue/handoff boundary
  - must not gain operator-runbook logic
- `workspace`
  - remains the owner of cleanup mechanics
  - operator docs may describe how to inspect retained workspaces, but docs do not decide retention policy
- `runner`
  - remains provider-neutral execution plumbing
  - runbooks should stay provider-neutral unless a specific supported command difference matters
- `orchestrator`
  - remains the owner of restart/retry/watchdog/landing state
  - tests may validate those contracts, but this issue should not add new hidden operator-only state
- `observability`
  - remains the canonical operator read model
  - docs should teach operators to trust those surfaces instead of reconstructing truth from raw processes first

## Slice Strategy And PR Seam

This issue should land as one reviewable operations seam:

1. add the checked-in `#169` plan
2. add one durable operator runbook and one failure-drills guide under `docs/guides/`
3. tighten `README.md`, `docs/guides/self-hosting-loop.md`, and `skills/symphony-operator/SKILL.md` so they point to the canonical procedures instead of duplicating them
4. add a focused stability/concurrency validation slice over the mocked factory harness

Deferred from this PR:

- new recovery/runtime policy changes if the drills expose product gaps
- live multi-host or real external chaos validation
- broader operator UX redesign for status/control surfaces
- report/archive expansions beyond what is needed to reference existing artifacts in the runbook

Why this seam is reviewable:

- the primary concept is operator credibility, not new runtime behavior
- docs and validation stay tied to existing runtime contracts instead of widening into tracker or runner architecture work
- the test seam is narrow: one named stability/concurrency slice that proves the documented procedures rest on real behavior

## Runtime State Model Notes

This issue should not invent new orchestration states. The runbooks, drills, and tests must explicitly use the existing Phase 6 state vocabulary already owned elsewhere:

### Factory-Level States To Document And Validate

1. `healthy`
   - detached runtime is running and no degraded recovery posture is active
2. `waiting-expected`
   - the factory is intentionally waiting on plan review, CI/review follow-up, or landing
3. `restart-recovery`
   - startup reconciliation is actively inspecting inherited work or has visible restart decisions to report
4. `retry-backoff`
   - one or more issues are queued for retry
5. `watchdog-recovery`
   - a stalled run was detected and recovery or recovery exhaustion is being surfaced
6. `degraded`
   - the runtime or observability contract is impaired and operators must intervene

The runbooks should map each posture to the supported commands, expected evidence, and next operator action.

### Per-Issue States To Document And Validate

1. active running execution
2. awaiting plan review / awaiting human handoff
3. awaiting CI or automated review resolution
4. awaiting landing command
5. queued retry/backoff
6. watchdog-aborted or recovery-exhausted
7. failed with retained workspace or cleaned workspace outcome

The drills should describe how to confirm each state through existing status and artifact surfaces rather than direct process inference alone.

## Failure-Drill Matrix

Because this issue is about recovery credibility, the plan should carry an explicit operator drill matrix even though the policy already exists in code.

| Drill / observed condition | Local facts available | Normalized tracker/runtime facts available | Expected operator action | Expected system behavior |
| --- | --- | --- | --- | --- |
| Detached factory is stopped unexpectedly | no live detached runtime; control pid/session absent or stale | `factory status` reports stopped/degraded; issues may still be `symphony:running` | use supported `factory status` then `factory start`/`factory restart`; confirm startup posture | runtime restarts cleanly and publishes startup/recovery posture |
| Factory restarts while an issue is still marked `symphony:running` | local lease/artifacts from prior ownership may exist | restart recovery details visible in status snapshot | inspect `restart recovery` summary and per-issue decision before taking manual action | system adopts, suppresses, requeues, or degrades according to existing restart policy |
| Runner stalls and watchdog intervenes | retained workspace/logs may exist; runner pid may be gone after abort | watchdog/retry posture and last action visible in status | inspect status/watch output and retained artifacts; do not relaunch manually unless runtime is stuck | watchdog recovery or exhaustion is recorded and normal retry/fail policy continues |
| Transient failure queues a retry | no live runner for the issue between attempts | retry queue plus pressure/recovery posture visible in status | wait for retry window unless degraded/blocking conditions exist | issue retries without losing the coordination state |
| Failure leaves retained workspace for diagnosis | retained workspace path and local issue artifacts exist | terminal failure / retention summary visible in status or issue artifacts | inspect retained workspace, confirm cleanup/retention outcome, decide whether to relabel for rerun after fix | workspace retention follows configured policy and remains inspectable |
| Multiple ready issues run under configured concurrency | more than one workspace/runner may be active | status/watch surfaces show concurrent active issues without inconsistent posture | use status/watch as primary coordination surface; avoid acting as second scheduler | runtime respects `max_concurrent_runs` and keeps postures legible under load |

## Implementation Steps

1. Add this plan under `docs/plans/169-operator-runbooks-failure-drills-and-stability-testing/plan.md`.
2. Add a focused operator runbook under `docs/guides/` that covers:
   - supported control commands
   - daily health-check flow
   - safe restart/stop/watch procedures
   - interpretation of the current status/recovery vocabulary
   - plan-review and landing checkpoints
3. Add a focused failure-drills guide under `docs/guides/` that walks through the supported recovery scenarios and points to the expected evidence in status/artifacts.
4. Update `README.md`, `docs/guides/self-hosting-loop.md`, and `skills/symphony-operator/SKILL.md` to link to the canonical runbook/drills and keep only the shorter entry-point guidance inline.
5. Add a narrow mocked stability/concurrency validation slice:
   - extend or add e2e coverage for representative concurrent issues under `max_concurrent_runs > 1`
   - validate operator-visible status remains coherent while multiple issues are active and while one issue enters retry/recovery posture
   - reuse shared builders/helpers instead of duplicating ad hoc test harness setup
6. Add any lightweight contract coverage needed for new operator-facing docs-linked outputs or fixtures introduced by this slice.
7. Run formatting, lint, typecheck, unit/integration/e2e tests required for the touched surfaces.
8. Perform a local self-review pass, fix findings, then continue through PR/CI/review loop.

## Tests

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- focused e2e execution for the new or expanded stability/concurrency scenario if split from the main test run during development
- `npx tsx tests/fixtures/tui-qa-dump.ts` if TUI or watch-surface wording/layout changes as part of documenting or validating operator posture

## Acceptance Scenarios

1. A new operator can follow one checked-in runbook to start the factory, inspect health, understand recovery posture, and know when manual intervention is or is not appropriate.
2. An operator can follow one checked-in drill guide to rehearse restart recovery, watchdog-driven recovery, retry/backoff, and retained-workspace diagnosis without relying on hidden tribal steps.
3. `README.md` and `docs/guides/self-hosting-loop.md` point clearly to the canonical runbook/drill docs instead of carrying fragmented recovery procedure text.
4. `skills/symphony-operator/SKILL.md` stays concise and points to the deeper procedure docs while preserving the wake-up-loop policy.
5. A repeatable mocked stability/concurrency test proves the factory remains operationally legible under more than one active issue and mixed recovery posture.
6. The new docs and tests stay aligned with current detached-control and observability contracts on `main`; they do not require undocumented local scripts or direct `screen` attachment as the normal path.

## Exit Criteria

- checked-in runbook and failure-drill docs exist and are linked from the main operator entry points
- the guidance matches the current runtime/status/control behavior on `main`
- a named stability/concurrency validation slice exists in tests and passes locally
- standard local validation passes
- local self-review findings are addressed
- a PR referencing `#169` is opened, CI is green, and review feedback is addressed

## Deferred

- any code changes that introduce new recovery posture or operator controls discovered as separate product gaps during the drills
- broader load testing beyond the mocked local harness
- real external-service fault injection in CI
- richer archive/report automation for operator drill output capture
- multi-instance coordination or hosted-operator procedures

## Decision Notes

- Keep the first PR grounded in the existing runtime contracts. If the drills reveal missing runtime truth or an operator-visible ambiguity that cannot be documented honestly, record that as a follow-up issue rather than silently redefining the current behavior in docs.
- Prefer a small number of durable guides with explicit cross-links over scattering recovery procedures across `README.md`, `SKILL.md`, and plan documents.
- Keep the stability slice realistic but bounded: it should prove operational legibility under concurrency and recovery, not become a generic load-testing framework.
