# Issue 218 Plan: Installed Engine Distribution

## Status

- plan-ready

## Goal

Make Symphony usable as an npm-installed engine CLI against a project-local `WORKFLOW.md` without requiring users to clone the `symphony-ts` source repo.

This first slice should make the built package self-runnable for the core engine path: the installed `symphony` binary must be able to target a project repository, preserve the existing instance-rooted `.tmp/` / `.var/` contract, and launch detached factory control without relying on `pnpm tsx bin/symphony.ts`.

## Scope

- define the supported installed-engine product model for this slice:
  - install Symphony as a package/CLI
  - keep `WORKFLOW.md` in each target repository
  - keep runtime state under the target repository's instance-owned `.tmp/` and `.var/`
- remove source-checkout-only engine self-invocation from detached factory control
- add a reusable engine-entrypoint helper that works from both:
  - a source checkout during development
  - a built or packed distribution during installation
- update package metadata so the built CLI is installable as an npm package
- add focused docs for installed-engine usage and current constraints
- add focused tests that prove a packed distribution can run the supported CLI paths against an external project-local instance

## Non-goals

- npm registry publishing automation, release workflows, or versioning policy
- replacing the repo's development workflow based on local source checkouts
- redesigning runtime layout away from `<instance-root>/.tmp/factory-main`
- tracker transport, normalization, or lifecycle-policy changes
- orchestrator retry, continuation, reconciliation, or landing-state changes
- packaging every repo-local operator workflow for installed use in this slice
- installed distribution support for `pnpm operator`, repo-local skills, or report/archive tooling unless a narrow runtime dependency proves unavoidable
- Windows-specific detached-runtime support changes beyond whatever already works through the current CLI contract

## Current Gaps

- `package.json` exposes a `bin` entry, but the package is still marked `private`, so the current repo cannot be installed as the intended engine distribution
- detached factory startup still shells out to `pnpm tsx bin/symphony.ts run`, which only works from a source checkout with development tooling present
- tests lock in source-checkout command strings like `pnpm tsx bin/symphony.ts run`, so current regression coverage would reject an installed-compatible invocation contract
- docs and operator-facing examples overwhelmingly describe source-checkout commands, not the installed-engine model from the issue
- there is no contract test proving that `npm pack` output can be installed into a separate project and operate on that project's `WORKFLOW.md`
- runtime identity and status surfaces already tolerate non-git environments, but there is no explicit installed-package path proving that the engine remains inspectable when it is not running from a git checkout

## Decision Notes

- Narrow the issue to the engine distribution seam first. Full installed-product support would otherwise mix package publication, detached runtime invocation, operator-loop packaging, docs, and release process in one PR.
- Keep the target-repository instance contract from `#214`, `#215`, and `#216`. Installation form factor changes should not change where runtime state lives.
- Prefer one engine-entrypoint resolution helper over scattered command-string branching. Detached control and any future self-invocation should share the same contract.
- Preserve local development ergonomics. Source-checkout workflows such as `pnpm tsx bin/symphony.ts ...` may remain documented for contributors, but runtime-owned self-invocation must not depend on them.
- Treat installed distribution support as a runtime contract, not just package metadata. A publishable package that cannot start its own detached runtime is incomplete.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned product rule that Symphony may be installed as an engine CLI while `WORKFLOW.md` and runtime state remain owned by each target repository
  - belongs: the rule that engine self-invocation must work from an installed distribution, not just from a contributor checkout
  - does not belong: child-process spawning details, package-manager command strings, or screen/process inspection internals
- Configuration Layer
  - belongs: resolving the selected workflow path and deriving instance-owned runtime paths exactly as today
  - belongs: resolving the running engine's executable entrypoint in a typed helper rather than hardcoding source paths
  - does not belong: detached process supervision logic or tracker-side policy
- Coordination Layer
  - belongs: keeping `run`, `status`, and detached `factory` control aligned on the same installed-engine invocation contract
  - does not belong: retry budgeting, reconciliation, review-loop state, or new orchestration lifecycle states
- Execution Layer
  - belongs: detached startup invoking the current engine through a portable command that works from source and installed builds
  - belongs: packaging the runtime assets that the engine actually needs at execution time
  - does not belong: tracker mutation policy or workflow rendering rules unrelated to engine launch
- Integration Layer
  - belongs: npm package metadata and packed-distribution install tests as the outer distribution boundary for the engine
  - does not belong: tracker API changes, remote-host protocol changes, or operator-loop packaging if it is not required for this first engine slice
- Observability Layer
  - belongs: status/runtime identity remaining legible when the engine runs from an installed package rather than a git checkout
  - belongs: docs/output language that distinguishes the engine install from the target-project instance
  - does not belong: a new status schema or unrelated TUI redesign

## Architecture Boundaries

### Engine entrypoint resolution

Belongs here:

- deriving the command and executable path for "run the current Symphony engine again"
- supporting both source-checkout and built-distribution layouts
- exposing a small reusable contract that detached control can consume

Does not belong here:

- tracker selection
- workflow parsing
- package publication workflow automation

### Detached factory control

Belongs here:

- replacing the hardcoded `pnpm tsx bin/symphony.ts run` command with the portable engine-entrypoint contract
- preserving the current detached locale, screen, and instance-selection behavior

Does not belong here:

- package metadata decisions beyond consuming the resolved engine command
- operator-loop state management

### Package / distribution boundary

Belongs here:

- package metadata required for installation
- selecting which built runtime assets ship in the package
- packed-distribution smoke/integration tests

Does not belong here:

- npm publish CI
- registry credentials, provenance, or release automation

### Docs and operator guidance

Belongs here:

- documenting the supported installed-engine workflow for target repositories
- clarifying which commands remain contributor-source-checkout commands versus end-user installed-engine commands

Does not belong here:

- a broad README rewrite
- packaging repo-local skills as a separate installed product unless the implementation proves they are runtime-critical

## Slice Strategy And PR Seam

This issue should land as one reviewable PR on one seam: make the core Symphony engine installable and self-runnable outside a source checkout.

What lands in this PR:

1. a portable engine self-invocation contract used by detached factory control
2. package metadata and shipped asset changes required for npm installation of the engine CLI
3. focused docs for the installed-engine model and its current limits
4. focused tests proving a packed distribution can target a project-local `WORKFLOW.md`

What is deliberately deferred:

- npm release automation and registry publication
- installed-distribution support for the checked-in operator loop
- installed-distribution support for report/archive helper CLIs unless separately required
- broader onboarding or release-management docs

This seam is reviewable because it stays on engine distribution and self-invocation. It does not mix tracker seams, orchestrator state refactors, or operator-loop distribution work into the same patch.

## Engine Invocation Resolution Model

This issue does not change retries, continuations, reconciliation, or handoff states. The stateful surface here is how the running engine resolves "invoke Symphony again" across source and installed layouts.

### States

1. `entrypoint-unresolved`
   - the running process has not yet derived its portable engine command
2. `source-layout-resolved`
   - the running process identifies a contributor/source-checkout layout
3. `installed-layout-resolved`
   - the running process identifies a built or packed distribution layout
4. `entrypoint-ready`
   - a command/executable pair exists for self-invocation
5. `engine-dispatched`
   - detached control or another caller launches the resolved engine command
6. `entrypoint-resolution-failed`
   - the runtime cannot derive a valid executable path for the current layout

### Allowed transitions

- `entrypoint-unresolved -> source-layout-resolved`
- `entrypoint-unresolved -> installed-layout-resolved`
- `source-layout-resolved -> entrypoint-ready`
- `installed-layout-resolved -> entrypoint-ready`
- `entrypoint-ready -> engine-dispatched`
- `entrypoint-unresolved -> entrypoint-resolution-failed`
- `source-layout-resolved -> entrypoint-resolution-failed`
- `installed-layout-resolved -> entrypoint-resolution-failed`

### Contract rules

- detached factory launch must invoke the current engine through the resolved entrypoint contract rather than a hardcoded `pnpm tsx` source path
- installed-engine invocation must continue to honor explicit `--workflow <path>` instance targeting
- source-checkout contributor workflows may remain available, but the runtime must not require `pnpm`, `tsx`, or source `.ts` entrypoints to start itself
- failure messages should identify the missing or invalid engine entrypoint clearly enough to diagnose broken package contents

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized engine/instance facts available | Expected decision |
| --- | --- | --- | --- |
| Detached start runs from a contributor checkout | current executable, repo layout, selected workflow path | valid source-layout engine entrypoint, valid instance paths | build the portable command and launch normally |
| Detached start runs from an installed package | current executable, package layout, selected workflow path | valid installed-layout engine entrypoint, valid instance paths | build the portable command and launch normally without `pnpm tsx` |
| Packed distribution is missing the built CLI entrypoint | package files on disk, selected workflow path | instance paths only | fail clearly before launch with a packaging/entrypoint error |
| Installed engine targets an external repo via `--workflow` | installed binary path, explicit workflow path | project-local instance paths | operate on the target repo's instance-owned `.tmp/` / `.var/` only |
| Installed engine runs outside a git checkout | executable path, status/startup snapshots | runtime identity collector returns non-git source | status remains readable and explicit about non-git runtime identity |
| Source-checkout contributor runs existing manual `pnpm tsx bin/symphony.ts ...` commands | source repo layout | valid instance paths | continue to work for development without being the runtime-owned self-invocation path |

## Storage / Persistence Contract

- no new orchestrator durable state is introduced
- the installed engine must continue to write runtime state under the selected target repository's existing instance-owned paths:
  - `<instance-root>/.tmp/`
  - `<instance-root>/.var/`
  - `<instance-root>/.tmp/factory-main`
- package metadata may add shipped build assets, but installation must not create hidden machine-global runtime state outside normal package-manager install locations
- status/startup snapshots remain in the target instance, not in the engine install directory

## Observability Requirements

- detached control output should continue to show the selected repository root and runtime root, regardless of whether the engine itself is running from source or an installed package
- runtime identity should remain explicit when the engine is not running from a git checkout
- docs must clearly distinguish:
  - the engine install location
  - the target repository that owns `WORKFLOW.md`
  - the target repository's instance-owned `.tmp/` and `.var/`
- packaging/entrypoint failures should name the missing runtime file or unsupported layout directly

## Implementation Steps

1. Add a small engine-entrypoint helper module that derives the current engine invocation command from the running layout and returns:
   - the executable to run
   - the argument vector for `symphony run`
   - any layout metadata useful for diagnostics
2. Refactor `src/cli/factory-control.ts` to use that helper for detached startup instead of `pnpm tsx bin/symphony.ts run`.
3. Update affected unit tests to assert the portable entrypoint contract rather than the source-only command string.
4. Update `package.json` and related build/package metadata so the engine package is installable and ships the build outputs required by the installed CLI path.
5. Add an integration test that:
   - builds or packs the package
   - installs it into a temporary consumer environment
   - creates a separate temp project repo with `WORKFLOW.md`
   - proves the installed `symphony` CLI can operate against that project's instance-owned paths on at least the supported non-network-dependent commands
6. Update README and any directly relevant operational docs with a concise installed-engine quick-start and current limitations.

## Tests And Acceptance Scenarios

### Unit tests

- engine-entrypoint helper resolves a valid source-layout command from a contributor checkout
- engine-entrypoint helper resolves a valid installed-layout command from built package paths
- detached factory launch uses the resolved engine-entrypoint contract instead of `pnpm tsx bin/symphony.ts run`
- packaging/entrypoint resolution failures mention the missing runtime file or unsupported layout
- runtime identity rendering stays explicit for non-git installed layouts

### Integration tests

- a packed or built distribution can be installed into a temporary consumer directory and run `symphony status --workflow <project>/WORKFLOW.md` against a separate temp project instance
- the installed CLI can inspect `factory status --workflow <project>/WORKFLOW.md` for a seeded temp instance without relying on the engine checkout as `cwd`
- detached-start command construction under the installed layout resolves to the shipped built CLI entrypoint

### End-to-end acceptance scenarios

1. Given a user installs the packaged Symphony engine and has a target repo containing `WORKFLOW.md`, when they run `symphony status --workflow /project/WORKFLOW.md`, then Symphony reads the target repo's instance-owned status path without needing a source checkout.
2. Given the same installed engine and target repo, when they run `symphony factory status --workflow /project/WORKFLOW.md`, then detached control inspects the target repo's instance-owned runtime paths and reports the selected repo/runtime roots clearly.
3. Given detached startup is requested from the installed engine, when Symphony builds the child command, then it launches the packaged engine entrypoint rather than `pnpm`, `tsx`, or source `.ts` files.
4. Given the installed engine is not running from a git checkout, when status surfaces render runtime identity, then they remain explicit about the non-git runtime source instead of failing or pretending the package is a checkout.

## Exit Criteria

- the Symphony package is installable as an engine CLI for this first slice
- detached factory startup no longer depends on `pnpm tsx bin/symphony.ts run`
- the installed CLI can target a project-local `WORKFLOW.md` while preserving the existing instance-rooted runtime contract
- focused docs describe the installed-engine workflow and current deferred areas
- focused unit/integration coverage proves the supported installed-engine contract

## Deferred To Later Issues Or PRs

- npm publication workflow, release automation, provenance, and registry policy
- installed-distribution support for the checked-in operator loop and repo-local skills
- installed-distribution support for additional helper CLIs such as report/archive commands unless separately prioritized
- broader productization work such as upgrade tooling, template generators, or platform-specific installers
