# Issue 218 Plan: Npm-Installable Symphony Engine And Installed CLI Distribution

## Status

- plan-ready

## Goal

Package Symphony as an npm-installable CLI engine that can operate against a project-local `WORKFLOW.md` without requiring the full `symphony-ts` source checkout, `pnpm`, or `tsx` on the consumer side.

This slice should preserve the multi-instance contract already established in `#214` through `#216`: the repository owning `WORKFLOW.md` remains the Symphony instance root, and its `.tmp/` / `.var/` trees remain the instance-owned runtime surface. The new work is to make the engine distribution install-safe by materializing the detached runtime from packaged assets rather than assuming a git checkout with `bin/symphony.ts`.

## Scope

- define one supported installed-engine distribution contract for the main `symphony` CLI
- make the npm package publishable and self-contained enough to run the main CLI after installation
- introduce a runtime-distribution/materialization seam so detached factory control can stage or refresh `<instance-root>/.tmp/factory-main` from the installed package instead of assuming a source checkout
- replace detached launch assumptions that hardcode `pnpm tsx bin/symphony.ts run` with an install-safe runtime command
- package any runtime assets the installed CLI needs to materialize the detached runtime and resolve its own entrypoints
- update docs and command guidance so source-checkout usage and installed-engine usage are both explicit
- add focused unit, integration, and end-to-end coverage that exercises the installed CLI from a packed tarball against a temp target repository

## Non-goals

- npm publishing automation, release workflows, provenance signing, or registry rollout
- packaging the repo-local operator loop as a product CLI command
- packaging `symphony-report` as a first-class installed command in this slice
- tracker transport, normalization, or lifecycle policy changes
- orchestrator retry, continuation, reconciliation, lease, or landing-state redesign
- changing the instance-rooted `.tmp/` / `.var/` ownership contract from `#214`
- changing the instance-scoped detached session identity or operator-state isolation from `#216`
- introducing remote execution or multi-host distribution updates as part of packaging

## Current Gaps

- `package.json` is still `"private": true`, so there is no publishable package contract yet
- the checked-in product command surface is documented primarily as `pnpm tsx bin/symphony.ts ...`, which assumes a source checkout rather than an installed CLI
- detached factory launch still hardcodes `pnpm tsx bin/symphony.ts run`, so `factory start` cannot work from an installed package
- the detached runtime home under `<instance-root>/.tmp/factory-main` is treated as a git checkout in docs and launch behavior rather than as a general runtime home that can be staged from packaged assets
- the operator helper remains repo-local by design, but it currently shells through repo-relative TypeScript entrypoints and is therefore not part of an install-safe product story
- current tests cover instance selection and detached isolation, but they do not lock in a real `npm pack` -> install -> run workflow against a consumer repository

## Decision Notes

- Keep the user-facing instance contract stable. `WORKFLOW.md` ownership should remain the source of truth for local runtime state whether the engine comes from a source checkout or an installed package.
- Keep `<instance-root>/.tmp/factory-main` as the detached runtime home for this slice, but stop assuming it is always a git checkout. In installed mode it becomes a staged runtime home produced from packaged engine assets.
- Narrow the installed-product surface to the main `symphony` CLI for this PR. Repo-local operator automation and reporting commands are useful, but packaging them here would broaden the seam and couple product installation to repo-specific tooling.
- Introduce one explicit runtime-distribution abstraction instead of scattering environment checks across `package.json`, factory control, and docs. The code should know whether it is running from a source checkout or an installed package and materialize runtime assets accordingly.
- Preserve self-hosting development. Source-checkout behavior must keep working so `symphony-ts` can continue building itself while the installed distribution seam is added.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that Symphony may be distributed as an installed CLI while the target repository owning `WORKFLOW.md` still owns runtime state
  - belongs: the rule that the supported installed product surface in this slice is the main `symphony` CLI, not every repo-local helper
  - does not belong: tarball build scripts, `screen` process management, or filesystem copy logic
- Configuration Layer
  - belongs: resolving the current engine distribution source and any packaged asset roots the runtime materializer needs
  - belongs: keeping `WORKFLOW.md` as the target-repo runtime contract while installation source is resolved separately
  - does not belong: tracker lifecycle policy or detached process supervision
- Coordination Layer
  - belongs: deciding when detached control must materialize or refresh the runtime home before launch
  - belongs: using the same selected instance contract regardless of whether the engine was installed or checked out from source
  - does not belong: tracker retries, handoff states, or review-loop policy
- Execution Layer
  - belongs: staging packaged runtime assets under `<instance-root>/.tmp/factory-main`, launching the detached worker with an install-safe command, and preserving existing workspace/runtime ownership
  - does not belong: tracker mutations or package-publishing automation
- Integration Layer
  - belongs: npm-package metadata, tarball install validation, and any packaged-asset resolution needed at the node/process boundary
  - does not belong: tracker transport or normalization changes
- Observability Layer
  - belongs: surfacing whether the runtime home came from a git checkout or an installed package clearly enough for diagnosis
  - belongs: docs and status/runtime identity wording that no longer assume the detached runtime is always a checkout
  - does not belong: choosing installation policy or mutating runtime state directly

## Architecture Boundaries

### Package / distribution contract

Belongs here:

- publishable package metadata
- the list of packaged runtime assets required by the installed CLI
- explicit installed-vs-source distribution detection

Does not belong here:

- tracker config parsing
- detached session control flow
- repo-local operator automation design

### Configuration and instance resolution

Belongs here:

- keeping `WORKFLOW.md` loading and instance-path derivation unchanged in principle
- resolving engine-distribution facts separately from instance ownership facts
- exposing any typed distribution/materialization inputs needed by CLI/runtime wiring

Does not belong here:

- file copying side effects
- `screen` launches
- package release automation

### Detached runtime materialization

Belongs here:

- staging or refreshing `<instance-root>/.tmp/factory-main` from the current engine distribution
- ensuring the staged runtime can execute `symphony run` without `pnpm tsx`
- keeping the target instance's workflow path and runtime-owned snapshots aligned with the staged runtime

Does not belong here:

- tracker policy
- operator-loop packaging
- broad runtime-update orchestration beyond the minimum needed to keep the detached runtime launchable

### CLI and detached factory control

Belongs here:

- resolving install-safe command invocation for foreground and detached runs
- invoking runtime materialization before detached start when needed
- keeping explicit `--workflow` instance selection from `#215`

Does not belong here:

- package build logic hidden inside ad hoc command strings
- git-checkout-only assumptions baked into the control surface

### Observability and docs

Belongs here:

- status/runtime identity wording that distinguishes git checkout vs installed package runtime homes
- install documentation for consumer repositories
- clear statement that repo-local operator tooling remains separate from the installed CLI

Does not belong here:

- a broad README rewrite
- unrelated TUI or report-surface redesign

## Slice Strategy And PR Seam

This issue should land as one reviewable PR focused on one seam: install-safe engine distribution for the main `symphony` CLI.

What lands in this PR:

1. publishable package metadata plus packaged runtime assets for the main CLI
2. a small runtime-distribution/materialization abstraction that supports source-checkout and installed-package execution
3. detached factory-control changes so `<instance-root>/.tmp/factory-main` can be staged from packaged assets and launched without `pnpm tsx`
4. focused install-path docs and tests, including a real tarball-install validation path

What is deliberately deferred:

- `symphony-report` as an installed product command
- promoting the repo-local operator loop into the installed product surface
- release automation and registry publication
- broader runtime update channels beyond the minimum staged-runtime refresh needed for correctness

This seam is reviewable because it stays on engine packaging and detached-runtime materialization. It does not mix tracker edges, orchestrator retry state, or repo-local operator workflow redesign into the same patch.

## Runtime Distribution Resolution Model

This issue does not change orchestration retries or handoff states, but it does introduce a stateful runtime-materialization path that should be explicit.

### States

1. `distribution-unresolved`
   - the current process has not yet classified whether it is running from a source checkout or an installed package
2. `distribution-resolved`
   - the runtime distribution source and packaged asset roots are known
3. `instance-resolved`
   - the selected `WORKFLOW.md` yields typed instance paths
4. `runtime-home-materializing`
   - `<instance-root>/.tmp/factory-main` is being staged or refreshed from the resolved distribution
5. `runtime-home-ready`
   - the detached runtime home has the files needed to execute the main CLI
6. `runtime-command-dispatched`
   - foreground or detached `symphony run` has been launched from the resolved distribution/runtime home
7. `materialization-failed`
   - packaged assets are missing, the runtime home cannot be staged, or the install-safe command cannot be derived

### Allowed transitions

- `distribution-unresolved -> distribution-resolved`
- `distribution-resolved -> instance-resolved`
- `instance-resolved -> runtime-home-materializing`
- `runtime-home-materializing -> runtime-home-ready`
- `runtime-home-ready -> runtime-command-dispatched`
- `distribution-unresolved -> materialization-failed`
- `distribution-resolved -> materialization-failed`
- `instance-resolved -> materialization-failed`
- `runtime-home-materializing -> materialization-failed`

### Contract rules

- the selected `WORKFLOW.md` remains the authoritative instance selector
- instance-owned `.tmp/` and `.var/` paths remain rooted at the repository that owns `WORKFLOW.md`
- detached runtime launch must not require `pnpm`, `tsx`, or source `.ts` files inside the consumer repository
- `<instance-root>/.tmp/factory-main` remains the detached runtime home, but may be either:
  - a git checkout in source-checkout development mode, or
  - a staged runtime home copied from packaged engine assets in installed mode
- installed-package execution should use one explicit packaged entrypoint contract rather than reconstructing ad hoc command strings in multiple places

## Failure-Class Matrix

| Observed condition                                                                                                   | Local facts available                                             | Normalized distribution / instance facts available                    | Expected decision                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `symphony run --workflow /project/WORKFLOW.md` is launched from an installed package                                 | installed CLI path, selected workflow path                        | installed-package distribution, resolved instance paths               | run successfully against `/project` without requiring a source checkout                 |
| `factory start --workflow /project/WORKFLOW.md` is launched from an installed package and the runtime home is absent | selected workflow path, empty `<instance-root>/.tmp/factory-main` | installed-package distribution, resolved instance paths               | materialize the runtime home from packaged assets, then launch detached runtime         |
| detached runtime home exists from an older staged package version                                                    | selected workflow path, existing runtime-home files               | resolved distribution version/asset identity, resolved instance paths | refresh or replace the staged runtime home deterministically before launch              |
| detached start still tries to use `pnpm tsx bin/symphony.ts run`                                                     | launch command builder, current process metadata                  | none or incorrect distribution facts                                  | fail tests and replace the launch path with the install-safe packaged command           |
| package tarball omits required runtime assets                                                                        | packed tarball contents, install test failure                     | incomplete installed-package distribution                             | fail install-path validation clearly; do not silently ship a partial package            |
| source-checkout self-hosting run executes from the repo root                                                         | repo checkout paths, selected workflow path                       | source-checkout distribution, resolved instance paths                 | preserve existing development behavior while flowing through the same distribution seam |
| runtime identity collection runs inside a staged runtime home that is not a git checkout                             | runtime-home path                                                 | resolved instance paths, installed distribution                       | report a non-git runtime identity clearly instead of assuming corruption                |

## Storage / Persistence Contract

- target-instance runtime state remains owned by the repository containing `WORKFLOW.md`
- `<instance-root>/.tmp/factory-main` remains the detached runtime home, but its contents may come from either:
  - the development checkout path, or
  - staged packaged assets from the installed engine
- status and startup snapshots remain under the existing instance-owned temp area
- reports and issue artifacts remain under the existing instance-owned `.var/` area
- no tracker-side persistence changes are introduced
- no release-registry metadata or publication logs are introduced as runtime state in this slice

## Observability Requirements

- `factory status` and related status surfaces should stop implying that the detached runtime is always a git checkout
- runtime identity reporting should remain explicit when the staged runtime home is not a git checkout and should not treat that as an unexplained error
- docs should clearly separate:
  - source-checkout development/self-hosting usage
  - installed-engine consumer usage
  - repo-local operator tooling that is still intentionally outside the installed product surface
- install-path failures should name the missing packaged asset, missing staged runtime file, or invalid launch command clearly

## Implementation Steps

1. Add a small engine-distribution module that classifies the current execution as source-checkout or installed-package and resolves the packaged asset roots/entrypoints needed by the main CLI.
2. Make `package.json` publishable for this slice:
   - remove `"private": true`
   - define the shipped files/exports/bin contract needed by the installed CLI
   - ensure the build output and any packaged runtime assets are included in the tarball
3. Introduce detached runtime materialization helpers that can stage or refresh `<instance-root>/.tmp/factory-main` from the resolved engine distribution while preserving the instance-owned workflow/runtime contract.
4. Refactor factory-control launch command construction so detached `symphony run` executes through an install-safe packaged entrypoint instead of `pnpm tsx bin/symphony.ts run`.
5. Update any foreground CLI wiring that still assumes source `.ts` entrypoints or repo-relative tooling paths for the main installed command.
6. Update runtime identity / status wording and minimal docs so operators can distinguish source-checkout vs installed-package runtime homes.
7. Add tarball-install validation that packs the current repo, installs it into a temp consumer environment, and exercises the installed main CLI against a temp target repo with `WORKFLOW.md`.
8. Update README and any focused operator/install docs to document:
   - installed-engine prerequisites and invocation
   - the continued instance-rooted ownership model
   - the deferred status of operator-loop/report packaging

## Tests And Acceptance Scenarios

### Unit tests

- engine-distribution resolution distinguishes source-checkout vs installed-package execution and produces the expected packaged entrypoints
- detached launch command construction no longer requires `pnpm`, `tsx`, or `bin/symphony.ts`
- runtime materialization derives the correct staged files for a selected instance
- runtime identity rendering stays explicit when the staged runtime home is not a git checkout

### Integration tests

- a packed tarball can be installed into a temp consumer directory and the installed `symphony` CLI can run against a separate temp target repo's `WORKFLOW.md`
- `factory start --workflow <target>/WORKFLOW.md` from the installed CLI materializes `<target>/.tmp/factory-main` and records startup/status output under the target instance
- source-checkout self-hosting paths still work after the distribution abstraction is introduced

### End-to-end acceptance scenarios

1. Given a temp target repository with its own `WORKFLOW.md`, when a consumer installs Symphony from the packed tarball and runs `symphony status --workflow /target/WORKFLOW.md`, then the command resolves the target instance without needing a source checkout.
2. Given the same installed package, when the operator runs `symphony factory start --workflow /target/WORKFLOW.md`, then Symphony stages `<target>/.tmp/factory-main` from packaged assets and launches the detached runtime without `pnpm tsx`.
3. Given the detached runtime is staged from an installed package, when `factory status` inspects it, then the status surface clearly reports the runtime home and a non-git identity source instead of assuming a git checkout.
4. Given the repo's own source checkout self-hosting flow, when a developer still runs the checked-in commands locally, then the development path continues to work through the same distribution seam.

## Exit Criteria

- the main `symphony` CLI is installable from an npm tarball and can operate against a project-local `WORKFLOW.md`
- detached factory launch no longer depends on `pnpm`, `tsx`, or repo-local `.ts` entrypoints
- `<instance-root>/.tmp/factory-main` can be materialized from packaged engine assets for installed use while preserving the existing instance-rooted runtime contract
- docs clearly distinguish installed-engine usage from source-checkout development usage
- focused install-path tests, including tarball install validation, pass locally

## Deferred To Later Issues / PRs

- `symphony-report` as an installed command
- packaging or promoting the repo-local operator loop into the installed product surface
- npm release automation and registry publication policy
- runtime self-update channels, version pinning policy, or staged-runtime rollback mechanics beyond what this slice needs
- broader doc consolidation once the installed product surface is larger than the main CLI
