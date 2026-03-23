# Issue 214 Plan: Multi-Instance Support Through An Instance-Rooted Runtime Contract

## Status

- plan-ready

## Goal

Define and land the first repo-owned runtime contract for a Symphony `instance` so one engine checkout can operate against multiple target project repositories, each with its own `WORKFLOW.md`, `.tmp/`, and `.var/` state.

This slice should make instance ownership explicit in typed config and path derivation, then move existing runtime, artifact, report, and detached-control helpers to consume that contract instead of inferring ownership from `workspace.root`, `workflowPath` parents, or the operator checkout root.

## Scope

- define a normalized instance-path contract rooted at the repository that owns `WORKFLOW.md`
- resolve and persist instance-owned paths during workflow loading instead of rediscovering them ad hoc
- update runtime path helpers for status, startup, startup mirror state, issue artifacts, issue reports, and campaign reports to derive from the instance contract
- update detached `factory` control path resolution so it targets the owning instance root rather than assuming the current checkout is the single factory repo
- add focused tests that prove two different instance roots derive isolated runtime/report/artifact paths from the same engine codebase
- update operator-facing docs to describe the instance-rooted contract and the new meaning of "repo root" for local operation

## Non-goals

- multi-instance coordination against the same tracker queue, cross-instance leases, or distributed ownership election
- tracker transport, normalization, or lifecycle policy changes
- runner transport redesign or remote-execution behavior changes
- changing retry, continuation, reconciliation, or review-loop state machines
- redesigning the detached runtime update/refresh workflow beyond deriving its paths from the instance contract
- replacing `.tmp/factory-main` as the runtime checkout location for this slice

## Current Gaps

- `src/config/workflow.ts` resolves `workflowPath` and `workspace.root`, but it does not expose a first-class instance root or runtime-layout contract
- `src/observability/status.ts`, `src/startup/service.ts`, and `src/startup/github-mirror.ts` derive owned files by walking upward from `workspace.root`, which makes ownership depend on layout heuristics instead of the repository that owns `WORKFLOW.md`
- `src/observability/issue-artifacts.ts`, `src/observability/issue-report.ts`, and `src/observability/campaign-report.ts` derive `.var` paths from `workspace.root` with `.tmp`-specific heuristics, which is brittle for multi-instance local operation
- `src/cli/factory-control.ts` hardcodes `.tmp/factory-main` under the outer repository root and treats that repository as the single active factory instance
- current docs still describe detached control primarily in terms of the engine checkout instead of the target project repository that owns the runtime contract
- current tests cover many individual path helpers, but they do not lock in the higher-level rule that `WORKFLOW.md` ownership defines the entire instance runtime surface

## Decision Notes

- Keep this slice centered on configuration and path ownership. The value is the contract itself, not a broad multi-instance feature set.
- Treat the repository containing `WORKFLOW.md` as the instance root. That repository owns runtime state, startup/status artifacts, reports, and the detached runtime checkout under `.tmp/factory-main`.
- Continue to let a shared engine checkout provide code, but do not let code-checkout location decide where an instance stores its runtime state.
- Prefer one typed `instance` layout contract over repeated helpers that each recompute parents differently.
- Do not broaden this issue into coordination or tracker policy. Path ownership must become explicit before those later multi-instance slices can be reviewed sanely.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that the repository containing `WORKFLOW.md` owns the Symphony instance and all repo-local runtime state
  - belongs: the rule that path ownership is explicit contract data, not an inferred convention from arbitrary cwd or nested temp paths
  - does not belong: filesystem traversal code, JSON snapshot writes, or detached-session process control
- Configuration Layer
  - belongs: deriving typed instance paths from `workflowPath` and resolved workflow config, and exposing those paths as part of the resolved runtime contract
  - does not belong: tracker policy, workspace git commands, or detached session lifecycle logic
- Coordination Layer
  - belongs: consuming the resolved instance contract when orchestration needs runtime-owned files or identity metadata
  - does not belong: re-deriving runtime parents from workspace roots inline inside orchestrator logic
- Execution Layer
  - belongs: runtime-owned execution directories such as workspace roots, startup mirror paths, and detached runtime checkout locations derived from the instance contract
  - does not belong: tracker lifecycle semantics or multi-instance lease coordination
- Integration Layer
  - belongs: intentionally untouched in this slice; tracker transport/normalization/policy should not move just because instance paths are being clarified
  - does not belong: instance-root path ownership, artifact roots, or detached runtime control defaults
- Observability Layer
  - belongs: status/startup/artifact/report paths and operator-facing rendering that should project the resolved instance root and runtime-owned locations clearly
  - does not belong: deciding which repository owns the instance contract

## Architecture Boundaries

### Policy / repo contract

Belongs here:

- the definition that one instance is rooted at one repository-owned `WORKFLOW.md`
- the rule that `.tmp/` and `.var/` are instance-owned, not engine-owned globals

Does not belong here:

- process management
- ad hoc path joins in each subsystem

### Configuration

Belongs here:

- resolving `instanceRoot` from `workflowPath`
- resolving a typed runtime layout such as runtime checkout root, workspace root, startup/status paths, mirror root, artifact root, and report root
- validating any invariants that the runtime layout depends on

Does not belong here:

- file creation
- tracker/review policy
- detached session monitoring

### Execution / workspace-startup boundary

Belongs here:

- consuming the resolved instance layout for workspace roots and startup mirror paths
- keeping workspace and startup state under the instance-owned runtime surface

Does not belong here:

- inventing alternate instance-root rules
- report/artifact heuristics based on workspace-root parents

### Observability

Belongs here:

- consuming resolved artifact/report/status/startup paths
- surfacing instance-root/runtime-root information in logs or status when useful for diagnosis

Does not belong here:

- deciding instance ownership from `.tmp` traversal

### CLI / detached factory control

Belongs here:

- finding the owning instance root from cwd or explicit workflow context
- targeting that instance root's `.tmp/factory-main` checkout and runtime-owned files

Does not belong here:

- duplicating config/path derivation logic independently from workflow loading
- assuming the engine checkout is always the active instance root

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one path-contract seam:

1. define a first-class instance-rooted runtime layout in config/domain code
2. move existing path helpers to consume that layout
3. update detached factory control to resolve the active instance from the owning `WORKFLOW.md`
4. add focused tests and docs proving isolated per-instance local operation

Deferred from this PR:

- concurrent operation policy across multiple instances pointed at the same tracker
- tracker-side identity or coordination changes
- any redesign of factory checkout refresh/update workflows
- broader UX work for managing many instances at once

This seam is reviewable because it stays on runtime ownership and path derivation. It does not combine tracker changes, retry-state refactors, or runner transport changes in the same patch.

## Instance Path Resolution Model

This issue does not change orchestrator retries or handoff state. The stateful surface here is instance-path ownership and resolution.

### States

1. `workflow-located`
   - a concrete `WORKFLOW.md` path is available
2. `instance-root-derived`
   - the owning repository root for that workflow is resolved
3. `runtime-layout-derived`
   - typed instance-owned paths are derived for `.tmp`, `.var`, runtime checkout, status/startup, mirrors, and reports
4. `runtime-paths-consumed`
   - CLI, startup, workspace, and observability surfaces use the shared layout contract
5. `resolution-failed`
   - required ownership facts cannot be derived or validated

### Allowed transitions

- `workflow-located -> instance-root-derived`
- `instance-root-derived -> runtime-layout-derived`
- `runtime-layout-derived -> runtime-paths-consumed`
- `workflow-located -> resolution-failed`
- `instance-root-derived -> resolution-failed`
- `runtime-layout-derived -> resolution-failed`

### Contract rules

- the instance root is the directory containing the instance-owned `WORKFLOW.md`
- instance-owned runtime state must derive from the instance root, not by walking upward from `workspace.root`
- helpers that need runtime-owned files should consume the shared layout contract or facts derived directly from it
- the detached runtime checkout remains `.tmp/factory-main` for this slice, but that location is relative to the instance root

## Failure-Class Matrix

| Observed condition                                                               | Local facts available                              | Normalized instance facts available       | Expected decision                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Workflow is loaded from a target repo with relative `workspace.root`             | `workflowPath`, raw workspace root                 | instance root and runtime layout          | resolve all runtime-owned paths under that target repo instance                                   |
| A helper receives only `workspace.root` today                                    | workspace-root path                                | none                                      | refactor helper to consume the instance layout instead of inferring ownership from parent paths   |
| Detached factory control runs from inside `.tmp/factory-main`                    | cwd inside runtime checkout, runtime `WORKFLOW.md` | owning instance root and runtime root     | resolve the same instance root and control paths cleanly                                          |
| Detached factory control runs from a target repo root                            | cwd at repo root, instance `WORKFLOW.md` present   | owning instance root and runtime root     | target that repo's `.tmp/factory-main` without assuming the engine checkout is the instance root  |
| Detached factory control runs outside any instance root                          | cwd only                                           | none                                      | fail clearly with an instance-root discovery error                                                |
| Two different repos load their own `WORKFLOW.md` files with the same engine code | two workflow paths, two workspace roots            | two distinct instance layouts             | derive disjoint `.tmp` / `.var` / report paths; no collisions                                     |
| Existing runtime artifacts live under `.var` while workspace root is customized  | workflow path, configured workspace root           | instance root, artifact root, report root | keep artifacts/reports anchored to the owning instance root, not to workspace-root parent guesses |

## Storage / Persistence Contract

- the instance root owns all repo-local runtime state for that instance
- runtime checkout path remains `<instance-root>/.tmp/factory-main`
- status and startup snapshots remain instance-owned runtime files under the resolved runtime temp area
- startup mirror state remains instance-owned temporary state under the resolved runtime temp area
- issue artifacts remain under `<instance-root>/.var/factory/issues/...`
- generated issue and campaign reports remain under `<instance-root>/.var/reports/...`
- no tracker-side persistence changes are introduced in this issue

## Observability Requirements

- logs should make the resolved instance root diagnosable where runtime layout is important
- status and startup helpers should consume the same instance contract so operator surfaces cannot silently disagree about file ownership
- artifact/report generation should stay explicit about the instance-owned roots they read from and write to
- error messages for detached control should name the missing instance root or `WORKFLOW.md` boundary clearly

## Implementation Steps

1. Add a typed instance-runtime contract under config/domain code that resolves from `workflowPath` and includes at least:
   - `instanceRoot`
   - `runtimeRoot`
   - `workspaceRoot`
   - `statusFilePath`
   - `startupFilePath`
   - `githubMirrorPath`
   - `factoryArtifactsRoot`
   - `issueReportsRoot`
   - `campaignReportsRoot`
2. Thread that contract through workflow loading so the resolved config exposes instance-owned paths without requiring downstream parent-walking heuristics.
3. Refactor status/startup/mirror/artifact/report path helpers to consume the shared instance contract or focused helpers derived from it.
4. Refactor detached `factory` control path discovery to resolve the active instance root from the owning `WORKFLOW.md`, then target that instance's `.tmp/factory-main`.
5. Update docs to clarify that:
   - the target project repo owning `WORKFLOW.md` is the instance root
   - one engine checkout can operate against many target repos
   - `.tmp/` and `.var/` are instance-owned paths
6. Add tests that prove per-instance isolation and preserve existing detached-control behavior inside a single instance.

## Tests And Acceptance Scenarios

### Unit tests

- workflow/config resolution derives a stable instance-rooted layout from `workflowPath`
- status/startup/artifact/report helpers consume the shared layout instead of inferring parents from `workspace.root`
- detached `factory` control resolves the same instance whether cwd is the instance root or the nested runtime checkout
- detached `factory` control fails clearly when no owning instance root can be found

### Integration tests

- two temp repositories with distinct `WORKFLOW.md` files derive disjoint runtime, artifact, and report paths from the same codebase
- artifact/report generation writes under each instance's `.var` root even when workspace roots are customized

### End-to-end acceptance scenarios

1. Given a target project repository with its own `WORKFLOW.md`, when Symphony loads that workflow, then runtime-owned files resolve under that repository rather than the engine checkout.
2. Given two target project repositories on the same machine, when each loads its own workflow, then their `.tmp/factory-main`, status/startup snapshots, and `.var` outputs do not collide.
3. Given the operator runs `symphony factory status` from a target repo root, when the detached runtime exists under that repo, then the command inspects that repo's instance runtime successfully.
4. Given the operator runs `symphony factory status` from inside the nested runtime checkout, when the runtime `WORKFLOW.md` is present, then the command still resolves the same owning instance.

## Exit Criteria

- a typed instance-rooted runtime contract exists and is used by the affected path-derivation surfaces
- no affected helper derives `.tmp` or `.var` ownership by walking up from `workspace.root`
- detached factory control targets the owning instance root instead of a single engine repo assumption
- docs describe the instance-rooted contract clearly enough for local multi-instance operation
- relevant unit/integration/e2e tests pass

## Deferred To Later Issues Or PRs

- shared-queue coordination across multiple local instances
- multi-instance operator surfaces that list or manage many instances together
- remote/distributed runtime state ownership beyond the local instance-root contract
- any tracker policy needed to prevent two independent instances from claiming the same work

## Final Decision Notes

1. The repo-owned contract should name the instance root explicitly rather than continuing to derive ownership from `workspace.root`. That is the only stable seam that works when many target repos each own their own runtime.
2. Keeping `.tmp/factory-main` unchanged but making it instance-relative keeps this slice narrow and reviewable while still unblocking multi-instance local operation.
