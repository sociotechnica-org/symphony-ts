# Issue 217 Plan: Multi-Instance Scaffolding And Third-Party README Onboarding

## Status

- plan-ready

## Goal

Make the local multi-instance path usable for third-party repositories by adding one repo-owned way to scaffold a project-local `WORKFLOW.md` and by documenting the engine-checkout versus instance-root operating model clearly in the README and operator guides.

This slice should let an operator keep one Symphony engine checkout, generate a starter workflow inside another repository, point Symphony at that workflow, and understand the supported day-one commands without reverse-engineering the current self-hosting setup.

## Scope

- add one supported instance scaffolding surface that writes a starter `WORKFLOW.md` into a target repository
- add a checked-in starter workflow template that is suitable for third-party repositories instead of copying the `symphony-ts` self-hosting prompt verbatim
- keep the scaffolded runtime contract aligned with the existing instance-rooted path and `--workflow` selection behavior from `#214`, `#215`, and `#216`
- update README onboarding so a third-party operator can:
  - prepare a target repository
  - scaffold or copy a project-local workflow
  - configure `tracker.repo`
  - run Symphony from the engine checkout against that target repository
- update the operator-facing docs where they still read primarily like self-hosting instructions
- add focused tests for the scaffolding command/template and the new onboarding contract

## Non-goals

- tracker transport, normalization, or lifecycle-policy changes
- orchestration retry, continuation, reconciliation, lease, or handoff-state changes
- multi-instance coordination across several instances that target the same tracker queue
- packaging Symphony as an installed global binary or changing the current `pnpm tsx` entrypoint model
- creating a full workflow-template marketplace or a large prompt-template framework
- redesigning the checked-in self-hosting `WORKFLOW.md` contract for `symphony-ts`
- inventing an alternate instance selector beyond the existing `--workflow <path>` contract

## Current Gaps

- the repository now supports instance-rooted runtime paths and explicit `--workflow` targeting, but there is no repo-owned way to generate a target repo's first `WORKFLOW.md`
- the checked-in root [`WORKFLOW.md`](../../../WORKFLOW.md) is self-hosting specific and should not be copied blindly into unrelated repositories
- the README explains the multi-instance contract in pieces, but it still reads primarily as "clone `symphony-ts` and run it here" rather than "use this engine checkout to operate another repo"
- the operator runbook and self-hosting guide mention explicit workflow targeting, but they do not provide a clean third-party onboarding path from an empty target repo to a first working instance
- there are no tests that lock in a repo-owned starter template or verify the CLI scaffolding surface writes the intended third-party workflow contract

## Decision Notes

- Keep this slice on onboarding and scaffolding only. The prior multi-instance slices already established runtime ownership, selection, and detached-session isolation; this issue should not reopen those seams.
- Prefer one explicit scaffolding command over README-only manual copy/paste. The value here is a stable repo-owned path that future docs and operators can reference.
- Keep the scaffolded workflow generic. It should express the baseline Symphony runtime contract without assuming `symphony-ts`-specific plan paths, labels beyond the tracker defaults, or repository-specific issue instructions.
- Reuse checked-in template assets rather than embedding a large workflow template inline inside CLI code.
- Preserve the existing self-hosting workflow file. Third-party onboarding should be additive and should not weaken the repo's own worker contract.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned contract for what Symphony considers a valid starter third-party instance workflow
  - belongs: the operator-facing rule that one engine checkout may scaffold and run many project-local instances via `WORKFLOW.md`
  - does not belong: file writes, CLI flag parsing, or runtime path derivation internals
- Configuration Layer
  - belongs: template material and any typed scaffold inputs that become workflow front matter
  - belongs: keeping the generated workflow compatible with existing workflow parsing and instance-root resolution
  - does not belong: tracker API traffic, detached-session control, or orchestration policy
- Coordination Layer
  - belongs: intentionally untouched in this slice except for reusing the existing command-time instance-selection contract
  - does not belong: retry budgeting, reconciliation, queue coordination, or plan-review state logic
- Execution Layer
  - belongs: the CLI command that writes a workflow file into a target repo and any supporting template-loading helpers
  - does not belong: runner-session control, workspace preparation changes, or detached-runtime lifecycle changes
- Integration Layer
  - belongs: documenting how the scaffolded workflow should set `tracker.repo`, runner selection, and optional repo-local clone source fields at the edge
  - does not belong: tracker-adapter code changes or mixed tracker-policy logic inside the scaffold command
- Observability Layer
  - belongs: clear scaffold output and docs that tell the operator what file was written and how to run the new instance
  - does not belong: new status-snapshot schema or runtime telemetry changes

## Architecture Boundaries

### Policy / starter-instance contract

Belongs here:

- the rule that third-party onboarding gets one checked-in starter workflow contract
- the rule that the starter template is generic and repo-owned

Does not belong here:

- hand-built string concatenation in CLI code
- tracker-specific runtime behavior

### Configuration / workflow template

Belongs here:

- the starter template content
- any placeholder or parameter-substitution rules for values such as target tracker repo, runner kind, or command examples
- keeping the generated front matter parseable by `loadWorkflow()`

Does not belong here:

- deciding where to write the file on disk at runtime
- detached control or status rendering

### CLI scaffolding surface

Belongs here:

- one explicit command for creating a target repo `WORKFLOW.md`
- argument parsing and validation for target path, overwrite behavior, and required inputs
- printing the resulting file path plus immediate next steps

Does not belong here:

- runtime startup or detached control logic
- tracker API reads or git remote mutation

### README / runbook onboarding

Belongs here:

- third-party setup instructions that distinguish the engine checkout from the target instance repo
- examples that show `init` or equivalent scaffolding plus `run` / `factory` commands using `--workflow`
- preserving self-hosting guidance while adding a clearly separate third-party path

Does not belong here:

- changing day-two operator policy unrelated to onboarding
- redefining the self-hosting loop as the only supported operating mode

## Slice Strategy And PR Seam

This issue should land as one reviewable PR focused on one seam: third-party instance onboarding.

What lands in this PR:

1. one supported scaffolding command that creates a starter `WORKFLOW.md` in a target repository
2. one checked-in starter template asset for third-party workflows
3. README and runbook updates that explain the engine checkout versus project-local instance model and show the scaffolded path
4. focused unit and integration coverage that lock the new scaffold contract and docs-adjacent CLI behavior

What is deliberately deferred:

- richer template variants or template inheritance
- automatic tracker label creation or repository bootstrap automation on GitHub
- automatic inference from git remotes or repository metadata beyond a narrow explicit CLI contract
- multi-instance dashboarding or same-queue coordination policy

This seam is reviewable because it stays on CLI/template/docs onboarding. It does not combine tracker adapter changes, orchestrator state changes, or detached-runtime control changes in the same patch.

## Scaffolding Resolution Model

This issue does not change long-running orchestration state. The stateful surface is command-time workflow scaffolding.

### States

1. `target-selected`
   - the operator identifies a target repo or workflow output path
2. `inputs-validated`
   - required scaffold inputs are present and the target location is acceptable
3. `template-resolved`
   - the checked-in starter template and substitutions are ready
4. `workflow-written`
   - the target `WORKFLOW.md` is created or intentionally overwritten
5. `instructions-rendered`
   - the command prints the next-step guidance for using the new instance
6. `scaffold-failed`
   - validation, template loading, or file writes fail

### Allowed transitions

- `target-selected -> inputs-validated`
- `inputs-validated -> template-resolved`
- `template-resolved -> workflow-written`
- `workflow-written -> instructions-rendered`
- `target-selected -> scaffold-failed`
- `inputs-validated -> scaffold-failed`
- `template-resolved -> scaffold-failed`
- `workflow-written -> scaffold-failed`

### Contract Rules

- the scaffold command must write a repo-local `WORKFLOW.md` for the selected target instance instead of mutating the engine checkout's workflow by default
- the starter template must remain valid under the existing workflow parser without requiring hidden local state
- the generated workflow must keep the established instance-root rule: the repository containing that file owns `.tmp/`, `.var/`, and `.tmp/factory-main`
- scaffold output must tell the operator how to run Symphony against the generated workflow from the engine checkout

## Failure-Class Matrix

| Observed condition                                                              | Local facts available                               | Normalized scaffold facts available      | Expected decision                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Target repository exists and has no `WORKFLOW.md`                               | target path, no existing file                       | selected output path and template inputs | write the starter workflow and print next-step commands                              |
| Target repository already has `WORKFLOW.md` and overwrite is not set            | target path, existing file                          | selected output path                     | fail clearly without modifying the file                                              |
| Target repository already has `WORKFLOW.md` and overwrite is set                | target path, existing file, explicit overwrite flag | selected output path and template inputs | replace the file deterministically and print that overwrite occurred                 |
| Required scaffold input such as tracker repo is missing                         | argv only                                           | none                                     | fail with command-usage guidance; do not write a partial file                        |
| Checked-in starter template cannot be read                                      | repo files, template path                           | none                                     | fail clearly as a repo/setup bug rather than silently generating a fallback template |
| Operator runs the generated workflow from the engine checkout with `--workflow` | engine checkout cwd, generated workflow path        | instance-rooted workflow path            | existing runtime should load the target instance without new multi-instance logic    |

## Storage / Persistence Contract

- the scaffold command writes only the selected target repository's `WORKFLOW.md`
- no new orchestrator durability or tracker persistence is introduced
- checked-in starter template assets live in the repository and are part of reviewable source control
- generated target-repo runtime state remains governed by the existing instance-root contract from `#214`

## Observability Requirements

- the scaffold command should print the written `WORKFLOW.md` path and concise next steps
- overwrite and validation failures should be explicit about the target file path
- README and guide examples should name which commands run from the engine checkout and which files live in the target repository
- onboarding docs should remain explicit that status, factory control, and operator loop commands can target the new instance via `--workflow <path>`

## Implementation Steps

1. Add one checked-in starter workflow template for third-party repositories in a focused template/examples location.
2. Add one CLI scaffolding command, likely `symphony init`, that:
   - accepts a target directory or workflow path
   - accepts the required tracker repo input for the generated workflow
   - optionally accepts explicit overwrite or runner-selection inputs if the chosen contract needs them
   - writes the starter template with deterministic substitutions
   - prints concise next-step instructions for `run`, `factory status`, and `factory start`
3. Keep template rendering/loading logic small and explicit instead of embedding a large template string directly in the CLI parser.
4. Update README quick-start and configuration guidance to split:
   - engine checkout setup
   - target repo scaffolding
   - running against a project-local instance
5. Update operator-facing docs that currently imply self-hosting first so they point third-party users at the scaffolded path when appropriate.
6. Add focused tests for CLI parsing, file generation, overwrite protection, and generated workflow compatibility with `loadWorkflow()`.

## Tests And Acceptance Scenarios

### Unit tests

- CLI argument parsing accepts the chosen scaffold command and rejects missing required values cleanly
- the scaffold command refuses to overwrite an existing `WORKFLOW.md` unless explicitly told to do so
- the generated workflow contains the provided tracker repo and the expected instance-local path defaults
- the generated workflow remains parseable through `loadWorkflow()`

### Integration tests

- from the engine checkout, the scaffold command can generate a `WORKFLOW.md` in a separate temp target repo and print the expected next-step guidance
- a generated third-party workflow can be loaded and its instance-rooted paths resolve under the target repo rather than the engine checkout
- README-adjacent command examples remain correct through targeted CLI contract tests where feasible

### End-to-end acceptance scenarios

1. Given an empty target repository, when the operator runs the scaffold command from the engine checkout, then the target repo receives a valid starter `WORKFLOW.md`.
2. Given that generated workflow, when the operator runs `pnpm tsx bin/symphony.ts status --workflow <target>/WORKFLOW.md`, then Symphony resolves the target repo as the active instance.
3. Given that generated workflow, when the operator follows the README onboarding steps, then the commands and path ownership model are explicit enough to start the instance without copying the `symphony-ts` self-hosting workflow file.
4. Given an existing target `WORKFLOW.md`, when the operator omits overwrite, then the scaffold command fails without clobbering the repository's current workflow contract.

## Exit Criteria

- the repository provides one supported way to scaffold a project-local `WORKFLOW.md` for a third-party repo
- the scaffolded workflow is generic, parseable, and aligned with the existing instance-rooted runtime contract
- README and relevant runbooks explain the engine-checkout versus target-instance workflow clearly
- focused tests cover the new CLI/template contract and generated workflow validity

## Deferred To Later Issues Or PRs

- additional starter-template flavors for different policy styles or trackers
- GitHub repository bootstrap automation such as label creation
- template migration tooling for upgrading existing third-party workflows
- broader multi-instance coordination and same-queue safety across several active instances
