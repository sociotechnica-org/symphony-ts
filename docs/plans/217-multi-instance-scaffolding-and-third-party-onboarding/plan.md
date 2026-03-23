# Issue 217 Plan: Multi-Instance Scaffolding And Third-Party README Onboarding

## Status

- plan-ready

## Goal

Make project-local multi-instance Symphony usable by someone who does not own
this repository by adding one repo-owned scaffolding path for a target
repository `WORKFLOW.md` and by rewriting the README/onboarding docs around the
instance model instead of assuming self-hosting context.

This slice should let an operator keep one engine checkout, generate or copy a
reviewable `WORKFLOW.md` into a separate target repository, point Symphony at
that project-local instance explicitly, and understand the minimum day-one setup
from checked-in docs alone.

## Scope

- add one supported scaffolding surface that writes a project-local
  `WORKFLOW.md` from a versioned checked-in template
- keep the scaffold output reviewable and minimal rather than generating hidden
  machine-owned state
- allow the scaffold path to target a repository other than the engine checkout
- document the third-party setup flow in `README.md` and related runbooks
- explain how one engine checkout can operate multiple project-local instances
  through explicit `--workflow` targeting
- add focused unit and integration coverage for scaffold generation and
  cross-repo onboarding examples

## Non-goals

- tracker transport, normalization, or lifecycle policy changes
- orchestration retry, continuation, reconciliation, lease, or handoff-state
  changes
- detached runtime/session identity redesign beyond documenting the existing
  multi-instance contract
- an interactive installer, TUI wizard, or hosted setup service
- packaging/publishing work such as npm release or standalone binaries
- validating external GitHub labels, secrets, or runner installation beyond the
  existing runtime checks and documentation
- multi-instance coordination against the same tracker queue

## Current Gaps

- the checked-in root `WORKFLOW.md` doubles as the repo's own runtime contract
  and as the only concrete example, which makes third-party adoption depend on
  copying maintainer-owned config by hand
- the CLI exposes `run`, `status`, `factory`, and report commands, but there is
  no repo-owned command to scaffold a target repository `WORKFLOW.md`
- `README.md` explains instance ownership and explicit `--workflow` targeting,
  but the quick-start path still starts from cloning `symphony-ts` itself rather
  than from "I have another repo and want Symphony to work it"
- the self-hosting and operator docs are written primarily for maintainers and
  do not provide one concise third-party setup flow from prerequisites to first
  run
- there is no checked-in reusable workflow template asset distinct from the
  repository's own active `WORKFLOW.md`
- tests cover loading arbitrary workflow files, but they do not lock in a
  stable scaffold contract for external users

## Decision Notes

- The reviewable seam for this issue is scaffolding plus onboarding, not new
  runtime coordination. Multi-instance runtime/path/selection/isolation seams
  were already established in `#214`, `#215`, and `#216`.
- Add one explicit scaffold command instead of asking users to manually edit the
  checked-in root `WORKFLOW.md`. The system should provide a versioned asset for
  that contract.
- Keep the scaffold artifact as plain `WORKFLOW.md` text committed in the target
  repo. Do not hide setup behind generated local state or opaque config stores.
- Prefer a small non-interactive command such as `symphony scaffold workflow`
  with explicit flags over a broad `init` product surface. The artifact we need
  is a file, not a project bootstrap framework.
- Use the checked-in scaffold asset as the source of truth so README examples,
  tests, and generated output stay aligned.
- Keep the target repo as the instance owner. The engine checkout remains code,
  tooling, and operator entrypoint only.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction
mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned contract that a third-party instance is still owned
    by the repository containing its `WORKFLOW.md`
  - belongs: the supported onboarding rule that scaffolded config is committed
    and reviewable in the target repo
  - does not belong: file writes, flag parsing, or workflow YAML parsing logic
- Configuration Layer
  - belongs: rendering or copying a checked-in workflow template into a concrete
    `WORKFLOW.md` with explicit user-provided values such as tracker repo and
    runner defaults
  - does not belong: tracker API checks, detached process management, or issue
    lifecycle logic
- Coordination Layer
  - belongs: intentionally untouched for runtime behavior; onboarding should use
    the existing instance selection contract rather than adding orchestration
    state
  - does not belong: retries, recovery, or multi-instance queue arbitration
- Execution Layer
  - belongs: a CLI entrypoint that writes the scaffold file to the selected
    target repository and examples showing `run`/`factory` against that
    `WORKFLOW.md`
  - does not belong: runner transport changes or detached-session policy
- Integration Layer
  - belongs: wiring the scaffold command into the CLI and keeping generated
    tracker config aligned with existing supported tracker kinds
  - does not belong: tracker transport/normalization/policy refactors
- Observability Layer
  - belongs: documentation and command output that make engine checkout vs
    instance root explicit during onboarding
  - does not belong: status-snapshot schema changes unrelated to setup clarity

## Architecture Boundaries

### Template asset / policy boundary

Belongs here:

- one checked-in scaffold template or template generator input
- the default comments and placeholders that explain what the operator must edit

Does not belong here:

- runtime discovery heuristics
- tracker network validation

### CLI scaffolding surface

Belongs here:

- parsing a narrow scaffold command and its flags
- resolving the target output path
- refusing to overwrite existing `WORKFLOW.md` unless explicitly allowed
- rendering/writing the template deterministically

Does not belong here:

- workflow loading for normal runtime execution
- ad hoc template strings duplicated in the CLI parser

### Workflow/config boundary

Belongs here:

- any small helper that renders a checked-in template from explicit inputs
- reuse of existing workflow defaults where that keeps the scaffold aligned with
  supported config

Does not belong here:

- special-case parsing paths for scaffolded files
- engine-checkout assumptions embedded into workflow semantics

### Docs and runbooks

Belongs here:

- a third-party quick-start flow in `README.md`
- a documented distinction between engine checkout, target repo, and
  project-local instance root
- examples for generating `WORKFLOW.md`, running one-shot commands, and using
  detached control with `--workflow`

Does not belong here:

- self-hosting-only assumptions as the primary setup story
- undocumented CLI behavior that only tests reveal

## Slice Strategy And PR Seam

This issue should land as one reviewable PR focused on one adoption seam:
project-local instance creation and onboarding.

What lands in this PR:

1. one checked-in scaffold asset plus a narrow CLI command that writes
   project-local `WORKFLOW.md`
2. guardrails around output path selection and overwrite behavior
3. README/runbook updates that teach third-party multi-instance setup from the
   engine checkout
4. focused tests proving the scaffold output is stable and usable with existing
   workflow loading

What is deliberately deferred:

- interactive prompts or setup wizards
- automatic label creation or GitHub repository mutation
- runtime validation of external prerequisites beyond current startup behavior
- multiple scaffold profiles beyond the minimal supported baseline
- packaging/distribution changes

This seam is reviewable because it stays on config asset generation and docs.
It does not mix tracker adapters, orchestrator state, or detached runtime logic
into the same patch.

## Scaffolding Resolution Model

This issue does not change long-running runtime state. The stateful surface is
the one-shot scaffolding flow for creating a project-local workflow file.

### States

1. `command-invoked`
   - the operator runs the scaffold command with a target path
2. `inputs-resolved`
   - target repository path, output path, and template inputs are normalized
3. `template-rendered`
   - scaffold content is rendered from the checked-in asset
4. `file-written`
   - `WORKFLOW.md` is written to the target repo
5. `scaffold-complete`
   - the command returns next-step guidance for running Symphony against the new
     instance
6. `scaffold-failed`
   - required inputs are missing, invalid, or blocked by an existing file

### Allowed transitions

- `command-invoked -> inputs-resolved`
- `inputs-resolved -> template-rendered`
- `template-rendered -> file-written`
- `file-written -> scaffold-complete`
- `command-invoked -> scaffold-failed`
- `inputs-resolved -> scaffold-failed`
- `template-rendered -> scaffold-failed`
- `file-written -> scaffold-failed`

### Contract rules

- the scaffold output is plain text `WORKFLOW.md` stored in the target repo
- the scaffold source is versioned in this repository, not assembled from hidden
  local state
- the scaffold command must target an explicit repository/path instead of
  guessing from unrelated `cwd`
- existing files should not be overwritten silently
- generated examples and docs must reflect the current multi-instance contract:
  target repo owns the instance, engine checkout supplies code and commands

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized scaffold facts available | Expected decision |
| --- | --- | --- | --- |
| Operator runs scaffold against `/projects/acme` with no existing `WORKFLOW.md` | target path, requested flags | output path and rendered content | write `WORKFLOW.md` successfully and print next steps using `--workflow /projects/acme/WORKFLOW.md` |
| Operator runs scaffold where `WORKFLOW.md` already exists | target path, existing file stat | output path | fail clearly unless an explicit overwrite flag is supported for this slice |
| Operator omits a required tracker repo value | provided flags only | incomplete template inputs | fail with a concrete missing-input error instead of generating invalid YAML silently |
| Operator runs scaffold from the engine checkout targeting another repo | caller `cwd`, explicit target path | target repo output path | write into the target repo; do not assume the engine checkout is the instance root |
| Scaffolded workflow is later loaded by normal config code | generated file content | resolved instance paths and config | load through the existing workflow/config path without scaffold-only parsing branches |
| README example uses a target repo outside the engine checkout | docs text only | explicit `--workflow` path contract | examples consistently point commands at the project-local instance instead of implying one global repo root |

## Storage / Persistence Contract

- the scaffold command writes only the target repository `WORKFLOW.md` for this
  slice
- no new durable orchestrator state is introduced
- no tracker-side persistence changes are introduced
- documentation may also add a checked-in scaffold template asset under a
  versioned repo path such as `src/config/` or `docs/`

## Observability Requirements

- scaffold command output should report the exact generated file path
- scaffold command output should print the minimum next steps:
  - edit required values if any placeholders remain
  - run `symphony ... --workflow <path>` from the engine checkout
- README/runbook text should keep engine checkout, target repo, and instance
  root terminology consistent
- onboarding examples should make failure boundaries visible, especially when
  required tracker repo or labels are still missing

## Implementation Steps

1. Add a checked-in workflow scaffold asset or template source separate from the
   repository's own active root `WORKFLOW.md`.
2. Add a narrow CLI scaffolding command, likely under `symphony scaffold
   workflow`, that:
   - accepts an explicit target repository or output path
   - accepts the minimum required template inputs
   - renders deterministic content
   - refuses silent overwrite
3. Factor any template-rendering helper into a small config-adjacent module so
   the CLI does not duplicate long inline template text.
4. Add command output that prints the generated path plus next-step commands
   using explicit `--workflow` targeting.
5. Rewrite the top-level README quick start around third-party onboarding:
   - clone/install the engine checkout
   - scaffold `WORKFLOW.md` into the target repo
   - confirm required tracker labels/prerequisites
   - run against the project-local instance
   - operate multiple instances by selecting distinct `WORKFLOW.md` paths
6. Update any related runbook or self-hosting guide text where current wording
   still implies the checked-out `symphony-ts` repo is the only normal instance
   root story.
7. Add tests for scaffold rendering, file-write guardrails, CLI parsing, and
   loading the generated workflow through existing config code.

## Tests And Acceptance Scenarios

### Unit tests

- CLI parsing accepts the new scaffold command and validates required flag values
- scaffold rendering produces stable `WORKFLOW.md` output from explicit inputs
- scaffold write path refuses to overwrite an existing `WORKFLOW.md` without an
  explicit opt-in if that flag exists
- generated workflow content loads successfully through existing workflow/config
  resolution

### Integration tests

- from the engine checkout, the scaffold command can generate
  `/target-repo/WORKFLOW.md` for a separate temp repository
- a scaffolded workflow for a temp target repo resolves instance-owned paths
  under that target repo, not under the engine checkout
- README-oriented example commands using `--workflow <target>/WORKFLOW.md`
  succeed in the tested temp setup where practical

### End-to-end acceptance scenarios

1. Given a third-party project repository with no `WORKFLOW.md`, when the
   operator runs the supported scaffold command from a Symphony engine checkout,
   then the target repo receives a reviewable `WORKFLOW.md` owned by that repo.
2. Given that scaffolded target repo, when the operator runs
   `pnpm tsx bin/symphony.ts run --workflow <target>/WORKFLOW.md`, then Symphony
   loads the target repo as the active instance instead of the engine checkout.
3. Given two target repositories with their own scaffolded `WORKFLOW.md` files,
   when the operator runs `factory status` or `operator` with explicit
   `--workflow` selectors, then each command targets the intended instance
   cleanly.
4. Given a user who has never self-hosted `symphony-ts`, when they follow the
   README third-party setup path, then the required steps and ownership model
   are understandable without reading internal code.

## Exit Criteria

- a repo-owned scaffold path exists for creating a target repository
  `WORKFLOW.md`
- the scaffold output is deterministic, reviewable, and validated by tests
- top-level onboarding docs teach third-party multi-instance setup explicitly
- the docs and scaffold output consistently describe the target repo as the
  instance root and the engine checkout as the command/tooling checkout
- no runtime coordination, tracker adapter, or detached-session behavior is
  changed beyond what is necessary to expose the existing multi-instance model

## Deferred To Later Issues Or PRs

- interactive onboarding UX
- automatic repository label/bootstrap mutation
- broader template/profile selection for different tracker/runner combinations
- published install artifacts and package-manager-first onboarding
- same-tracker multi-instance coordination guidance once that runtime policy
  exists
