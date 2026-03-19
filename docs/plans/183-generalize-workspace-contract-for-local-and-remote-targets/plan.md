# Issue 183 Plan: Generalize The Workspace Contract For Local And Remote Execution Targets

## Status

- plan-ready

## Goal

Refactor the workspace contract so Symphony can represent a prepared execution workspace as either:

- a local filesystem checkout on the current host, or
- a remote execution workspace on another host

while preserving the current local clone/fetch/branch lifecycle as the only concrete implementation in this slice.

The contract should move execution-target facts into the workspace layer instead of leaking them through startup config overrides or forcing runner adapters to invent their own remote-path model later.

## Scope

- define a normalized execution-workspace domain model that can describe local and remote prepared workspaces
- define a workspace-source / prepared-source contract so startup preparation can hand the workspace layer a prepared source without mutating `workspace.repoUrl`
- extend workspace preparation and cleanup contracts to carry host-aware metadata needed by future remote runners
- preserve the existing local workspace behavior as the default concrete implementation
- update local runner and orchestrator call sites to consume the generalized workspace contract without changing workflow or tracker policy
- add tests that lock in the new contract while proving the current local path still behaves the same
- update docs where the execution-layer workspace seam needs to be explicit

## Non-goals

- implementing a real remote workspace manager or remote runner transport
- introducing SSH, RPC, leases, or remote host coordination protocols
- changing tracker transport, tracker normalization, or tracker policy
- changing orchestrator retry, continuation, reconciliation, or handoff behavior
- redesigning startup mirror policy beyond threading its result through a typed workspace-source seam
- changing the local branch/reset semantics already covered by `#88`

## Current Gaps

- `src/domain/workspace.ts` defines `PreparedWorkspace` only as `{ key, path, branchName, createdNow }`, so the runtime equates "prepared workspace" with "local cwd on this host"
- `src/runner/local-execution.ts` and `src/runner/local-live-session.ts` read `session.workspace.path` directly for `cwd`, prompt-file writes, Codex session discovery, and environment variables, which hardcodes local-host execution assumptions into the runner boundary
- `src/cli/index.ts` still rewrites `workflow.config.workspace.repoUrl` from `startup.workspaceRepoUrlOverride`, so startup preparation leaks source-selection details through config mutation instead of a workspace-owned contract
- `src/workspace/service.ts` and `src/workspace/local.ts` do not distinguish:
  - source preparation versus per-issue workspace preparation
  - execution location metadata versus cleanup inputs
- current tests prove local workspaces and mirror-backed startup, but they do not lock in a provider-neutral workspace contract that future remote execution can implement without reworking the orchestrator or runner again

## Decision Notes

- Keep this slice inside the execution layer. The deliverable is a stable workspace contract plus local implementation updates, not a remote-execution feature.
- Reuse the existing startup-preparation seam, but narrow its output to a typed workspace-source override rather than mutating `workspace.repoUrl` at the CLI boundary.
- Keep local path access explicit and typed. Future remote-capable runners should be able to branch on a normalized execution target, not infer remote-ness from missing fields or ad hoc strings.
- Do not introduce fake remote execution. The plan should land inert, well-tested plumbing that preserves the current local happy path and makes the later remote slice smaller.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that a prepared workspace is an execution-layer contract, not an implicit local-path assumption
  - belongs: the rule that startup preparation may provide a prepared workspace source, while workspace preparation owns the per-issue execution workspace result
  - does not belong: git subprocess wiring, `cwd` branching, or remote transport details
- Configuration Layer
  - belongs: preserving `workspace.repoUrl` as the configured source repo and extending typed config only if the generalized contract needs explicit local-target defaults
  - does not belong: startup source overrides, mirror path rewriting, or remote host session metadata
- Coordination Layer
  - belongs: consuming the generalized workspace contract through `WorkspaceManager` and `RunSession`
  - does not belong: deciding local versus remote path semantics inline in the orchestrator
- Execution Layer
  - belongs: workspace source/preparation contracts, host-aware prepared workspace metadata, local workspace manager behavior, and runner consumption of the normalized execution target
  - does not belong: tracker lifecycle policy or remote worker control-plane design
- Integration Layer
  - belongs: unchanged tracker integration; no tracker transport or normalization changes are needed in this slice
  - does not belong: workspace host metadata or runner `cwd` decisions
- Observability Layer
  - belongs: logging the normalized execution target/source facts needed to diagnose local versus future remote workspace preparation
  - does not belong: deciding source-selection or execution-target policy

## Architecture Boundaries

### Domain / workspace contract

Belongs here:

- a normalized execution workspace model with explicit target metadata
- a typed representation of the prepared workspace source handed from startup to the workspace layer
- cleanup inputs that can identify a workspace without assuming only a local path

Does not belong here:

- git command execution
- runner subprocess launch logic
- tracker policy

### Startup

Belongs here:

- preparing or refreshing a reusable source checkout / mirror
- returning a typed prepared-source override for the workspace layer to consume

Does not belong here:

- per-issue workspace branch creation
- mutating resolved config to sneak in source overrides
- runner-specific execution metadata

### Workspace

Belongs here:

- consuming the configured source plus any startup-prepared source override
- creating the per-issue execution workspace
- returning explicit target metadata for local workspaces now, with a stable seam for remote targets later
- cleanup based on the generalized workspace identity

Does not belong here:

- remote runner command transport
- tracker handoff policy
- startup snapshot persistence

### Runner

Belongs here:

- consuming a normalized execution target from `RunSession.workspace`
- using local-only operations only when the workspace target kind is local

Does not belong here:

- inventing its own remote workspace model
- reaching back into startup/config to discover mirror paths or host metadata

### Orchestrator

Belongs here:

- passing the generalized prepared workspace through `RunSession`
- remaining agnostic to whether the workspace is local or remote unless policy explicitly needs that later

Does not belong here:

- path rewriting or host-transport branching

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one execution-layer seam:

1. generalize the workspace domain and service contracts
2. adapt the current local startup/workspace/runner path to those contracts
3. keep behavior unchanged for existing local runs
4. add focused tests and docs

Deferred from this PR:

- any real remote workspace manager
- remote runner execution or prompt transport
- host lifecycle, lease, or cleanup coordination across machines
- config UX for choosing remote execution targets

This seam is reviewable because it stays within workspace/startup/runner contracts and does not combine tracker, orchestration-state, or review-loop changes.

## Execution Workspace State Model

This issue does not change orchestrator retry or handoff state. The stateful surface here is the execution-layer workspace lifecycle.

### Prepared source states

1. `configured-source`
   - workflow config provides the canonical repo source
2. `startup-prepared-source`
   - startup returns a typed source override such as the local Git mirror path
3. `source-ready`
   - workspace preparation resolves the effective source it will clone or reuse
4. `source-failed`
   - startup or workspace cannot supply a usable source

### Execution workspace states

1. `preparing`
   - the workspace manager is creating or refreshing the per-issue workspace
2. `ready`
   - a normalized prepared workspace is available for the run session
3. `cleanup-pending`
   - the run ended and cleanup policy is about to act on the prepared workspace
4. `cleaned`
   - cleanup completed or the workspace was already absent
5. `cleanup-failed`
   - cleanup could not complete for the prepared workspace identity

### Allowed transitions

- `configured-source -> startup-prepared-source`
- `configured-source -> source-ready`
- `startup-prepared-source -> source-ready`
- `configured-source -> source-failed`
- `startup-prepared-source -> source-failed`
- `source-ready -> preparing`
- `preparing -> ready`
- `preparing -> source-failed`
- `ready -> cleanup-pending`
- `cleanup-pending -> cleaned`
- `cleanup-pending -> cleanup-failed`

### Contract rules

- every prepared workspace must declare its execution target kind explicitly
- local-only fields such as filesystem paths must remain accessible through the local target shape, not as nullable top-level fields that every consumer has to interpret
- cleanup must key off the normalized prepared workspace identity rather than assuming a local path string is always sufficient
- startup-prepared source data must remain separate from the configured repo source so future remote paths do not overwrite config state

## Failure-Class Matrix

| Observed condition                                                                     | Local facts available          | Normalized workspace facts available       | Expected decision                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Startup returns no override and workflow uses the configured local repo source         | resolved config                | source kind is configured/local            | workspace manager prepares the local workspace exactly as today                                |
| Startup returns a local mirror path                                                    | resolved config, mirror path   | source kind is startup-prepared/local-path | workspace manager clones/fetches from the prepared source without mutating `workspace.repoUrl` |
| Runner receives a local prepared workspace                                             | local path, branch name        | target kind is `local`                     | runner uses the local path as `cwd`, prompt-file location, and session-discovery root          |
| Runner receives a future non-local prepared workspace on the current local runner path | target metadata only           | target kind is not `local`                 | fail clearly at the execution boundary instead of silently assuming a local path               |
| Cleanup is requested for a retained or already-absent local workspace                  | workspace identity, local path | target kind is `local`                     | cleanup reports `deleted` or `already-absent` just as today                                    |
| Startup-prepared source metadata is malformed or unsupported                           | raw startup result             | no valid normalized source                 | fail loudly before workspace preparation starts                                                |

## Storage / Persistence Contract

- no new durable tracker state is introduced
- no new orchestrator runtime-state persistence is introduced
- startup artifacts may continue to persist startup summaries, but the runtime should not require them as the system of record for prepared workspace identity
- the generalized workspace contract should be serializable enough for future status/reporting use, but this slice does not require changing persisted status/report schemas unless the type changes force it

## Observability Requirements

- workspace-ready logs should include the normalized execution target kind and the effective source kind/path used for preparation
- startup logs should continue to identify when a prepared source override was produced, but without implying that config itself was mutated
- runner logs should report a clear unsupported-target failure if a local runner is ever asked to execute against a non-local prepared workspace
- no layer should hide target/source assumptions behind generic `path` logs alone once the contract is generalized

## Implementation Steps

1. Refine `src/domain/workspace.ts` to model:
   - the prepared workspace source contract
   - a normalized execution target shape with at least a local target variant and explicit room for a future remote variant
   - cleanup/result inputs that use the normalized workspace identity
2. Update `src/workspace/service.ts` so workspace preparation can accept the effective prepared-source context rather than only an issue.
3. Adapt startup preparation and CLI/runtime wiring so the startup mirror path is threaded as a typed workspace-source override instead of rewriting `workflow.config.workspace.repoUrl`.
4. Refactor `src/workspace/local.ts` to:
   - consume the generalized source contract
   - return the generalized local prepared workspace shape
   - preserve current clone/fetch/default-branch/cleanup behavior
5. Update `src/domain/run.ts`, `src/runner/local-execution.ts`, and `src/runner/local-live-session.ts` so the local runner consumes the normalized workspace target explicitly and fails clearly on unsupported non-local targets.
6. Update any orchestrator or test helpers that construct `PreparedWorkspace` directly so they use the new contract without changing orchestration policy.
7. Update README and any architecture/config references that currently describe workspaces as only local filesystem paths.

## Tests And Acceptance Scenarios

### Unit / focused tests

- workspace domain / helpers: local prepared workspace shape exposes explicit local target metadata and preserves branch/workspace identity
- startup-to-workspace wiring: a startup-produced local mirror override is passed through as a typed source override rather than config mutation
- local workspace manager: current local clone/reuse/default-branch behavior still passes through the generalized contract
- local runner: accepts a local prepared workspace target and launches exactly as before
- local runner: rejects a synthetic non-local prepared workspace with a clear unsupported-target error
- orchestrator/unit fakes: updated fake workspace managers and prepared-workspace fixtures still satisfy the contract cleanly

### Integration / end-to-end scenarios

1. Given the existing GitHub bootstrap mirror path, when startup prepares a local mirror and an issue runs, then workspace preparation consumes that mirror through the typed source contract and the run succeeds unchanged.
2. Given a reused local workspace, when the workspace manager prepares it again, then the issue branch/reset behavior remains unchanged under the generalized prepared workspace model.
3. Given a local runner and a synthetic non-local prepared workspace, when a run starts, then the runner fails immediately with an explicit unsupported-target error instead of trying to use a missing local path.

## Exit Criteria

- the runtime no longer defines `PreparedWorkspace` as only a local filesystem path
- startup-prepared source overrides flow through a typed workspace contract rather than config mutation
- the local workspace manager remains the working default implementation
- the local runner consumes explicit local target metadata and fails clearly on unsupported non-local targets
- tests cover the generalized contract plus the preserved local happy path
- docs describe the workspace layer as an execution-target seam rather than only a local checkout path

## Deferred To Later Issues Or PRs

- implementing a real remote execution workspace manager
- wiring a remote runner that can execute against the future remote target variant
- remote host lifecycle, credentials, or transport contracts
- observability/reporting changes that expose remote host details to operators
- config surface for selecting local versus remote execution targets
