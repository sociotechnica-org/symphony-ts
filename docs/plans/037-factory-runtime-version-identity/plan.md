# Issue 37 Plan: Factory Runtime Version Identity

## Status

`plan-ready`

## Goal

Expose a clear, immutable-enough runtime identity for the live local factory so an operator can answer "what version of the factory is running right now?" from the status surface and logs without inspecting git state by hand.

## Scope

This slice covers:

1. defining the first local runtime identity contract for the detached factory runtime
2. collecting that identity from the live runtime checkout under `.tmp/factory-main`
3. persisting the identity into operator-facing runtime snapshots
4. rendering the identity in `symphony status` and `symphony factory status`
5. emitting the same identity in structured logs at startup / snapshot publication points
6. tests and docs for the contract and operator usage

## Non-goals

This slice does not include:

1. semantic versioning, release tags, or release engineering automation
2. proving provenance beyond local git metadata
3. branch-name-based runtime identity as the primary answer
4. remote archive publication or report schema changes
5. redesigning orchestrator state, retry behavior, or tracker policy
6. comparing the live runtime against the operator checkout beyond surfacing each path distinctly when useful

## Current Gaps

Today the detached factory runtime does not expose a durable code identity:

1. `status.json` and `startup.json` describe worker/process state but not the runtime checkout revision
2. `factory status` can show the runtime root path, but the operator still has to run git commands manually to know which commit that checkout is on
3. logs do not carry a normalized runtime identity field that can be correlated across startup, status snapshots, and debugging
4. the status surface can be misread as describing the operator checkout on disk rather than the live runtime checkout under `.tmp/factory-main`
5. the future report path has no reusable runtime-identity contract to consume yet

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in [docs/architecture.md](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_37/docs/architecture.md).

- Policy Layer: define the repo-owned rule that local runtime identity is derived from immutable runtime checkout facts such as `HEAD` commit SHA and commit timestamp, not mutable branch names. This issue should not add tracker or landing policy.
- Configuration Layer: no workflow schema change is required in the first slice. Runtime identity is derived from the live runtime checkout path already owned by factory control and runtime startup.
- Coordination Layer: the orchestrator may publish identity into status snapshots it already owns, but it should not gain new dispatch or retry behavior.
- Execution Layer: runtime identity collection may inspect the runtime checkout on disk and capture process-start context, but runner/workspace layers should not become responsible for status rendering or git policy.
- Integration Layer: no tracker transport or normalization changes belong here. Git inspection is local runtime introspection, not tracker integration.
- Observability Layer: owns the runtime identity contract, snapshot fields, rendering, and structured log fields. This is the primary layer touched by the issue.

## Architecture Boundaries

### Observability

Belongs here:

1. a small `FactoryRuntimeIdentity` contract that can be embedded in startup/status snapshots
2. human-readable rendering for status surfaces
3. structured-log fields and helper formatting
4. read/write validation for the new snapshot fields

Does not belong here:

1. ad hoc shell parsing inside render functions
2. tracker-specific status policy
3. report-generation logic in this slice

### CLI / Factory Control

Belongs here:

1. resolving the live runtime root already used by detached control commands
2. surfacing runtime identity in `factory status` output
3. clearly distinguishing runtime checkout information from the operator repo root when both are shown

Does not belong here:

1. direct git command formatting in the terminal renderer
2. a second competing runtime identity model

### Startup

Belongs here:

1. collecting runtime identity early enough that startup and later status surfaces agree on the same live checkout facts
2. publishing identity in `startup.json` so early failures still report the running code version

Does not belong here:

1. release/version policy
2. retry or supervision changes

### Orchestrator

Belongs here:

1. carrying precomputed runtime identity into status snapshot publication
2. logging snapshot publication with identity context

Does not belong here:

1. recomputing git state inline in hot orchestration branches
2. deriving identity from issue/workspace branches

### Workspace / Runner

Belongs here:

1. no contract ownership changes in this slice

Does not belong here:

1. defining factory runtime identity from issue workspaces or runner sessions

### Tracker

Belongs here:

1. no changes

Does not belong here:

1. status-surface identity logic
2. any transport, normalization, or policy changes for this issue

## Proposed Runtime Identity Contract

Introduce one normalized runtime identity object owned by observability and derived from the live factory runtime checkout:

1. `checkoutPath`: absolute path to the live runtime checkout root
2. `headSha`: resolved `git rev-parse HEAD` value, or `null` when unavailable
3. `committedAt`: resolved `git show -s --format=%cI HEAD` value, or `null` when unavailable
4. `isDirty`: boolean when local diff state can be determined, otherwise `null`
5. `source`: a short normalized source/result summary such as `git`, `git-unavailable`, or `not-a-git-checkout`

Decision notes:

1. `headSha` is the primary operator answer because it is immutable for local debugging and does not depend on branch movement.
2. `committedAt` helps humans compare two SHAs quickly and gives reports/logs a readable anchor without inventing semver.
3. `isDirty` is useful for debugging local detached runtimes that have uncommitted changes, but it is secondary to `headSha`.
4. branch name may be shown as supplementary context later, but it should not be required for the first contract and should not be treated as identity.

## Runtime Publication Model

This feature does not change orchestration state transitions, so it does not need a new runtime state machine for retries or handoff logic.

It does need one explicit publication model:

1. collect runtime identity from the live runtime checkout before or during startup preparation
2. write the identity into `startup.json`
3. reuse the same identity when building `status.json` for that runtime process
4. render the identity in `status` / `factory status`
5. emit structured logs that include the same identity fields on startup and status publication

If identity collection fails:

1. the runtime should stay operable
2. snapshots should record the failure mode in normalized form
3. the status surface should say identity is unavailable rather than silently omitting the field

## Failure-Class Matrix

| Observed condition | Local facts available | Expected behavior |
| --- | --- | --- |
| Runtime checkout is a healthy git worktree | runtime root path, `HEAD` SHA, commit timestamp, diff status | publish full identity in startup/status snapshots and logs |
| Runtime checkout is a git worktree but diff check fails | runtime root path, `HEAD` SHA, commit timestamp, dirty state unavailable | publish SHA/timestamp with `isDirty: null` and source detail explaining the partial result |
| Runtime checkout is missing `.git` or git is unavailable | runtime root path only | publish identity with null git fields and a normalized unavailable source; status must say runtime identity unavailable, not crash |
| Detached runtime starts, then operator checkout advances later | runtime snapshot already persisted from live runtime root | status continues to report the live runtime checkout identity, not the operator checkout `HEAD` |
| Startup fails before orchestration reaches steady-state | startup snapshot exists | `factory status` still surfaces the runtime identity from `startup.json` for debugging |
| Status snapshot write/log render fails | runtime remains alive | log a warning and continue; runtime identity collection must not add a fatal observability dependency |

## Observability Requirements

Required operator-visible outcomes:

1. `symphony status` prints the runtime identity near the worker/runtime summary
2. `symphony factory status` prints the same identity alongside runtime root information
3. JSON status/control snapshots include a stable machine-readable runtime identity object
4. startup and status publication logs include runtime identity fields for grep/debugging
5. docs explain that the detached runtime identity describes `.tmp/factory-main`, not the operator checkout

## Slice Strategy And PR Seam

This issue should land as one reviewable PR because it stays on one seam: local runtime observability for the detached factory checkout.

The PR should include:

1. a small runtime identity collector/helper
2. snapshot contract updates for startup/status/control output
3. render/log wiring and tests
4. concise operator docs

The PR should explicitly defer:

1. issue report schema/rendering changes from future report-focused work
2. release/version labels or build pipelines
3. broader status-surface redesign beyond adding the new identity fields

## Implementation Steps

1. Add a small runtime-identity helper that inspects a checkout root and returns the normalized contract without throwing on expected git/environment failures.
2. Extend the startup snapshot contract to carry runtime identity so early detached-runtime failures still report the live code version.
3. Extend the factory status snapshot contract and builder to carry the same identity object.
4. Thread runtime identity through detached factory control inspection so `factory status` can render it even when only startup data is available.
5. Render the identity in human-readable `status` and `factory status` output with wording that distinguishes runtime checkout from operator repo root.
6. Emit structured log fields for startup preparation and status snapshot publication that include runtime identity.
7. Update docs for the detached-runtime operator flow and status interpretation.

## Tests

Add or update coverage for:

1. unit tests for runtime identity collection across healthy git, partial git failure, and non-git checkout cases
2. unit tests for startup snapshot parsing/rendering with runtime identity present and unavailable
3. unit tests for status snapshot parsing/rendering with runtime identity present and unavailable
4. unit tests for `factory status` rendering to confirm runtime root and runtime identity are both shown clearly
5. integration or CLI contract coverage, if needed, to ensure `status --json` and `factory status --json` expose the new fields

## Acceptance Scenarios

1. Detached runtime healthy: after `factory start`, `factory status` answers with the runtime checkout path and `HEAD` SHA for `.tmp/factory-main` without any manual git command.
2. Operator checkout diverged: if the operator repo root moves to a different commit after the runtime started, `factory status` still reports the live runtime SHA from the runtime checkout.
3. Startup failure: when startup fails after publishing `startup.json`, `factory status` still shows the runtime identity for the failed live runtime.
4. Identity unavailable: if the runtime checkout cannot provide git metadata, status surfaces say identity is unavailable in a normalized, non-crashing way.
5. JSON consumers: machine-readable status output includes the runtime identity object needed by future status/report consumers.

## Exit Criteria

This issue is complete when:

1. the live detached runtime publishes a normalized runtime identity derived from its own checkout
2. `status` and `factory status` surface that identity clearly
3. startup/status logs carry the same identity fields
4. tests cover healthy and unavailable identity cases
5. docs explain how operators should interpret the runtime identity

## Deferred To Later Issues Or PRs

1. adding runtime identity to generated issue reports or archive publication metadata
2. release-channel names, semantic versions, or signed build provenance
3. cross-checks that compare operator checkout and runtime checkout automatically
4. richer build metadata such as Node version, package version, or build host once a broader runtime-build contract exists
