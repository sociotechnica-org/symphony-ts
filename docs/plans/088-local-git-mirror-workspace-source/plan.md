# Issue 88 Plan: Local Git Mirror Workspace Source For GitHub Bootstrap

## Status

- plan-ready

## Goal

Land the local-mirror portion of closed PR `#75` as a repo-owned slice by teaching the GitHub bootstrap startup path to maintain a local mirror, then letting workspace creation clone from that mirror instead of cloning directly from GitHub.

The slice should preserve the startup contract added in `#86`, keep GitHub-specific mirror behavior at the edge, and make workspace preparation default-branch aware instead of hardcoding `main`.

## Scope

- add a GitHub-bootstrap startup preparer that creates or refreshes a local bare mirror from the configured source remote
- return a local-path workspace source override from startup preparation so workspaces can clone from the mirror
- resolve local-path `workspace.repo_url` values relative to `WORKFLOW.md`
- make workspace reset/branch creation default-branch aware by consulting the remote HEAD instead of assuming `main`
- add tests for fresh mirror creation, incremental mirror refresh, local-path config resolution, and workspace reuse against non-`main` default branches
- update operator-facing docs to describe the mirror-backed bootstrap path and local-path `workspace.repo_url` behavior

## Non-goals

- prompt-content changes from closed PR `#75`
- new wrapper CLIs or alternate startup entrypoints
- tracker trust-policy redesign
- broader workspace-manager refactors unrelated to source selection / default-branch resolution
- non-GitHub tracker mirror support in this issue

## Current Gaps

- `src/startup/service.ts` still selects a GitHub bootstrap no-op preparer, so startup preparation cannot harden or normalize the workspace clone source yet
- `src/workspace/local.ts` clones and fetches directly from `workspace.repoUrl`, which means bootstrap runs still trust the configured GitHub remote directly
- workspace preparation hardcodes `main` when resetting the base branch, so repos with `master` or any other default branch do not get a correct clean base checkout
- `src/config/workflow.ts` trims `workspace.repo_url` as a string but does not resolve local filesystem paths relative to the owning `WORKFLOW.md`
- existing tests cover derived GitHub clone URLs and direct local remotes, but not a startup-managed local mirror lifecycle or default-branch-aware reuse

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that GitHub bootstrap may prepare a local mirror during startup and hand that mirror path to workspace creation
  - belongs: the rule that workspace checkout follows the source repo default branch, not a hardcoded branch name
  - does not belong: raw git subprocess wiring or filesystem path joins
- Configuration Layer
  - belongs: resolving `workspace.repo_url` as either a remote URL or a local path relative to `WORKFLOW.md`
  - belongs: preserving the configured remote source URL separately from any startup-produced local override
  - does not belong: mirror refresh commands or branch checkout logic
- Coordination Layer
  - belongs: unchanged startup orchestration contract from `#86`, which executes one startup preparer before the runtime starts
  - does not belong: tracker API behavior, workspace git state, or prompt policy
- Execution Layer
  - belongs: git mirror creation/refresh, workspace clone source selection, default-branch-aware checkout/reset, and diagnosable workspace-prep failures
  - does not belong: GitHub issue/PR policy or tracker comment parsing
- Integration Layer
  - belongs: GitHub-bootstrap-specific startup preparer selection and source-remote handling
  - does not belong: generic workspace branch-reset policy that should remain tracker-agnostic once the source path is chosen
- Observability Layer
  - belongs: structured startup/workspace logs that show mirror create/refresh activity and explicit failure summaries
  - does not belong: deciding whether the GitHub bootstrap path should use a mirror at all

## Architecture Boundaries

### Configuration

Belongs here:

- typed workflow resolution for `workspace.repo_url`
- resolving local filesystem values relative to `path.dirname(workflowPath)`
- keeping the configured source remote URL/path distinct from any startup-produced override

Does not belong here:

- `git clone --mirror` / `git remote update` subprocesses
- startup artifact writing
- workspace branch checkout decisions

### Startup / GitHub bootstrap integration

Belongs here:

- a GitHub-bootstrap startup preparer that owns the local mirror lifecycle
- deriving a stable mirror location under the runtime-owned temp area, matching the repo-owned `github/upstream` intent
- returning `workspaceRepoUrlOverride` so the rest of the runtime can consume a local mirror path without duplicating GitHub logic

Does not belong here:

- issue polling or tracker review policy
- per-issue workspace branch creation
- prompt text changes

### Workspace

Belongs here:

- clone/fetch/reset operations against the resolved source repo path
- determining the source remote default branch from `origin/HEAD` with narrow fallbacks
- reusing the existing branch-reset behavior while basing it on the resolved default branch

Does not belong here:

- deciding where the GitHub mirror lives
- GitHub API calls or tracker-specific policy
- startup status persistence

### Tracker / orchestrator

- tracker
  - remains responsible for normalized GitHub issue/PR state only
  - must not absorb mirror filesystem management
- orchestrator
  - continues to consume the startup outcome and invoke workspace preparation
  - must not inline mirror refresh branches or GitHub-specific git policy

### Observability

Belongs here:

- startup and workspace logs for mirror create/refresh, chosen source path, default branch, and failures

Does not belong here:

- retry policy or hidden fallback behavior that would mask git failures

## Decision Notes

- Reuse the startup-preparation seam from `#86` instead of adding another wrapper command. That keeps mirror setup on the canonical `run` path and keeps detached control behavior consistent.
- Keep the GitHub mirror lifecycle in a focused startup module so the workspace layer only receives a resolved source path and default-branch facts.
- Preserve one reviewable PR by limiting this slice to source preparation and workspace consumption. Prompt trust-surface changes from `#75` remain explicitly deferred.

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one narrow seam:

1. replace the GitHub bootstrap startup no-op with a real local-mirror preparer
2. thread the startup-produced local source override into workspace preparation
3. make workflow repo-path resolution and workspace default-branch detection support that source cleanly
4. add focused tests and docs

Deferred from this PR:

- prompt-content filtering or startup prompt-hardening changes from `#75`
- alternate startup wrappers or operator CLI variants
- tracker-side trust or repository-identity redesign
- mirror reuse for non-GitHub trackers

This seam is reviewable because it stays within startup/config/workspace behavior. It does not combine tracker transport changes, orchestrator retry-state changes, or prompt rewrites in the same patch.

## Runtime State Model

The startup lifecycle already exists from `#86`; this issue adds a concrete GitHub-bootstrap provider and a narrower workspace source contract.

### Startup provider states

1. `preparing`
   - startup selected the GitHub mirror preparer and is inspecting or refreshing the mirror
2. `ready`
   - the mirror is usable and startup returns a local workspace source override
3. `failed`
   - mirror creation or refresh failed terminally and startup exits non-zero

### Workspace source states

1. `configured-source`
   - config resolved the raw `workspace.repo_url` value, either derived from `tracker.repo` or explicitly configured
2. `startup-override`
   - startup returned a local mirror path that supersedes the configured source for workspace cloning
3. `workspace-ready`
   - the workspace cloned/fetched from the resolved source and reset to the source default branch before checking out the issue branch

### Allowed transitions

- `configured-source -> startup-override`
- `configured-source -> failed`
- `startup-override -> workspace-ready`
- `startup-override -> failed`

### Decision facts

The startup/workspace seam should decide from:

- resolved workflow config
- filesystem existence/type of the mirror path
- git facts from the configured source remote and the mirror clone
- remote default-branch facts from `origin/HEAD` plus explicit `main` / `master` fallbacks only when `origin/HEAD` is absent

The seam should not decide from:

- tracker issue state
- prompt contents
- orchestrator retry counters

## Failure-Class Matrix

| Observed condition                                                       | Local facts available                                                          | Normalized startup/workspace facts available   | Expected decision                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Mirror path absent on first startup                                      | configured source URL/path, target mirror path                                 | no existing mirror                             | create bare mirror, return local override path                                                            |
| Mirror exists and source has new commits                                 | existing mirror repo, configured source, `git remote update --prune` succeeds  | remote HEAD resolves to current default branch | reuse mirror path, workspace later fetches new refs from mirror                                           |
| Mirror exists but configured source remote is unreachable                | existing mirror repo, git error text                                           | startup provider selected for GitHub bootstrap | fail startup loudly with provider/source/mirror path in the error summary; do not silently use stale data |
| Configured `workspace.repo_url` is a relative local path                 | workflow path, raw config value                                                | config resolves absolute repo path             | use resolved absolute path as the source remote for mirror creation or direct workspace cloning           |
| Workspace clone source remote default branch is `master`                 | workspace git checkout, `refs/remotes/origin/HEAD` resolves to `origin/master` | default branch resolved as `master`            | reset workspace to `origin/master` before issue-branch handling                                           |
| Source remote has no `origin/HEAD` symbolic ref but `origin/main` exists | workspace git checkout                                                         | `origin/HEAD` absent, `origin/main` exists     | fall back to `main` and proceed                                                                           |
| Source remote has neither `origin/HEAD` nor known fallback refs          | workspace git checkout, git verification failure                               | no default branch resolved                     | fail workspace preparation loudly with diagnosable error                                                  |

## Storage / Persistence Contract

- mirror state is stored as a local bare Git repository under the runtime-owned temp area, not under a per-issue workspace
- the startup snapshot remains the transient status surface; it does not become the system of record for mirror refs
- the mirror path should be deterministic from the workspace/runtime root so repeated runs reuse the same local cache
- no new tracker-side persistence is introduced in this issue

## Observability Requirements

- startup logs must identify whether the mirror was created fresh or refreshed in place
- startup failures must include enough context to diagnose the failing source remote and local mirror path
- workspace logs should record the resolved source path and detected default branch when preparing a workspace
- failures from local-path resolution, mirror setup, and default-branch detection should stay loud instead of silently falling back to a potentially wrong branch or stale source

## Implementation Steps

1. Add a focused GitHub-bootstrap mirror preparer under `src/startup/` that:
   - derives the local mirror path from the runtime/workspace root
   - creates the mirror with `git clone --mirror` on first use
   - refreshes an existing mirror from the configured source remote before each run
   - returns the mirror path as `workspaceRepoUrlOverride`
2. Replace the GitHub bootstrap no-op startup provider selection with the new mirror preparer while leaving other trackers on the existing no-op path.
3. Update workflow config resolution so explicit local-path `workspace.repo_url` values resolve relative to `WORKFLOW.md`; leave remote URLs and scp-style git URLs unchanged.
4. Thread the startup-produced source override into workspace preparation and make `LocalWorkspaceManager` resolve the source default branch from `origin/HEAD` before resetting the base branch.
5. Keep workspace error handling explicit and update logs so mirror/default-branch failures remain diagnosable.
6. Update docs covering the self-hosting/bootstrap flow and any config reference text that describes `workspace.repo_url`.

## Tests And Acceptance Scenarios

### Unit / focused tests

- workflow config: relative local `workspace.repo_url` resolves against `WORKFLOW.md`; remote URLs and scp-style git remotes are preserved unchanged
- startup mirror preparer: creates a mirror on first run and returns a local override path
- startup mirror preparer: refreshes an existing mirror and exposes new upstream commits on a later run
- startup mirror preparer: reports a clear failure when mirror creation or refresh fails
- workspace manager: resolves `origin/master` via `origin/HEAD` and resets the workspace against that branch instead of `main`
- workspace manager: fails clearly when no default branch can be resolved

### Integration / end-to-end scenarios

1. Given a GitHub-bootstrap workflow and no existing mirror, when startup runs, then it creates `github/upstream`, returns that path, and the first workspace clone succeeds from the mirror.
2. Given an existing mirror and a new upstream commit on the source remote, when a later startup runs, then the mirror refresh exposes the new commit and a reused workspace fetch/reset sees the update.
3. Given a source remote whose default branch is `master`, when a workspace is prepared, then the issue branch starts from `origin/master` and not from a nonexistent `origin/main`.
4. Given a relative local `workspace.repo_url`, when `WORKFLOW.md` is loaded from a temp repo, then the resolved source path is absolute and points at the sibling local repository.
5. Given a broken source remote or corrupted mirror bootstrap setup, when startup runs, then the run fails before orchestration starts and reports a diagnosable mirror error.

## Exit Criteria

- GitHub bootstrap startup creates or refreshes a reusable local mirror and returns it as the workspace clone source
- workspace preparation can clone from that local mirror path successfully
- workspace default-branch handling is no longer hardcoded to `main`
- relative local `workspace.repo_url` values resolve correctly against `WORKFLOW.md`
- tests cover fresh mirror creation, incremental refresh, and non-`main` default branches
- docs describe the repo-owned mirror behavior and local-path config rule

## Deferred To Later Issues Or PRs

- prompt hardening / injection-surface changes from closed PR `#75`
- any richer mirror health policy such as stale-but-usable fallback or background sync
- cross-tracker startup source normalization
- operator controls for mirror inspection, pruning, or relocation
