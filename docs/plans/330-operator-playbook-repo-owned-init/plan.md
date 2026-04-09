# Issue 330 Plan: Repo-Owned Operator Playbook And Init Scaffolding

## Status

- plan-ready

## Goal

Move repository-specific operator policy out of the engine-global
`skills/symphony-operator/` playbook and into a checked-in repo-owned contract
that lives alongside `WORKFLOW.md`, then teach `symphony init` to scaffold
that contract for new repositories.

The outcome of this slice is:

1. `symphony-ts` itself has a checked-in operator playbook for its own
   self-hosting policy.
2. external repositories get the same repo-owned surface when bootstrapped via
   `symphony init`.
3. the engine-global operator skill/prompt keeps only reusable method and
   tooling rules, while selected-instance policy comes from the selected
   repository.

## Scope

1. define one repo-owned operator playbook file, expected at
   `<instance-root>/OPERATOR.md`, as the selected repository's operator-policy
   contract
2. add a checked-in `OPERATOR.md` for `symphony-ts` and move repo-specific
   operator policy there from global operator assets where appropriate
3. update the checked-in operator prompt, skill, and operator-facing docs so
   they read the selected instance's `OPERATOR.md` when it exists and treat it
   as the primary source for repo-specific operator policy
4. extend `symphony init` so it scaffolds both `WORKFLOW.md` and `OPERATOR.md`
   for a target repository
5. add focused tests that lock the new repo-owned operator-contract and
   scaffolding behavior

## Non-goals

1. changing tracker transport, normalization, or handoff lifecycle policy
2. redesigning the operator wake-up ordering, release-state checkpointing, or
   landing semantics
3. moving runtime correctness guarantees out of code/tests and into markdown
   policy files
4. inventing a new workflow frontmatter section for operator policy in this
   slice
5. building a general template marketplace or multi-file project generator
   beyond the narrow `WORKFLOW.md` + `OPERATOR.md` scaffold seam
6. forcing existing third-party repositories to adopt `OPERATOR.md`
   immediately; missing-playbook fallback should remain explicit and safe

## Current Gaps

1. repo-specific operator policy still lives in the engine-global
   [`skills/symphony-operator/SKILL.md`](../../../skills/symphony-operator/SKILL.md)
   and
   [`skills/symphony-operator/operator-prompt.md`](../../../skills/symphony-operator/operator-prompt.md),
   even though rules such as post-merge refresh/restart expectations,
   release-advancement posture, and acceptable intervention vary by repository
2. `symphony init` currently writes only `WORKFLOW.md`, so a new third-party
   repository gets a runtime contract but no parallel repo-owned operator
   contract
3. the current docs describe the roles of `WORKFLOW.md`, `AGENTS.md`, and
   skills, but they do not give operator policy its own checked-in repository
   surface
4. current operator-loop wording tells the operator to read the selected
   repository's `WORKFLOW.md`, `AGENTS.md`, `README.md`, and relevant docs, but
   there is no single purpose-built repo-owned operator playbook to read there
5. existing init and operator-loop tests do not pin the contract that
   operator-specific repo policy is repo-owned and scaffolded

## Decision Notes

1. Use `OPERATOR.md` as the repo-owned operator playbook surface. It is
   parallel to `WORKFLOW.md` and `AGENTS.md`, obvious at the repository root,
   and inspectable in code review.
2. Keep engine-global operator assets focused on reusable method, tooling
   boundaries, and control-surface usage. They should not remain the only home
   for repository-specific operator policy.
3. Keep the current change as one reviewable seam: policy ownership plus init
   scaffolding. Do not expand into tracker changes, workflow-config redesign,
   or broader operator automation changes.
4. Preserve backward-compatible fallback when `OPERATOR.md` is absent. The
   operator should continue from `WORKFLOW.md`, `AGENTS.md`, `README.md`, and
   other checked-in docs that exist instead of silently importing
   `symphony-ts`-specific policy into another repository.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in
[`docs/architecture.md`](../../architecture.md).

- Policy Layer
  - belongs: the rule that repository-specific operator policy is owned by the
    selected repository in `OPERATOR.md`
  - belongs: the role boundaries between `WORKFLOW.md`, `AGENTS.md`,
    `OPERATOR.md`, repo-local skills, and code/tests
  - does not belong: shell wiring, file writes, or tracker-comment parsing
- Configuration Layer
  - belongs: scaffold inputs and template material for the new `OPERATOR.md`
    contract
  - belongs: explicit selected-instance doc lookup rules for the operator
  - does not belong: retry policy, review-state normalization, or release gate
    evaluation
- Coordination Layer
  - belongs: intentionally unchanged in this slice except for consuming the
    same selected-instance context with a different policy source of truth
  - does not belong: new retry, continuation, reconciliation, lease, or
    handoff-state behavior
- Execution Layer
  - belongs: `symphony init` file creation and operator prompt/skill behavior
    that reads the selected repository's playbook
  - does not belong: tracker lifecycle decisions or detached runtime control
    redesign
- Integration Layer
  - belongs: selected-instance path resolution and doc discovery at the
    boundary between engine tooling and the target repository
  - does not belong: mixing tracker policy or raw GitHub assumptions into init
    scaffolding or playbook lookup
- Observability Layer
  - belongs: scaffold output, operator-facing docs, and tests that make the
    repo-owned contract visible and inspectable
  - does not belong: new runtime status schema or hidden local policy state

## Architecture Boundaries

### `OPERATOR.md`

Belongs here:

1. repository-specific operator policy such as:
   - post-merge refresh/restart expectations
   - landing ownership and exceptions
   - release-advancement expectations
   - what counts as normal operator intervention versus a repository-specific
     escalation
2. durable repo-owned operator rules that should be reviewable in the selected
   repository

Does not belong here:

1. runtime correctness rules that must be enforced in code/tests
2. tracker transport details
3. local/generated notebook state under `.ralph/`

### Engine-global operator assets

Belongs here:

1. reusable operator method and checkpoint ordering
2. control-surface rules for `factory status`, `factory watch`, `factory
attach`, and the operator loop
3. the rule that selected-instance checked-in docs are authoritative when they
   exist

Does not belong here:

1. `symphony-ts`-specific operator policy presented as if it were universal
2. the only copy of a selected repository's operator playbook

### Init scaffolding

Belongs here:

1. deterministic creation of `WORKFLOW.md` and `OPERATOR.md`
2. overwrite validation that avoids partial or surprising repo mutations
3. concise next-step output that points at both repo-owned contracts

Does not belong here:

1. tracker API reads
2. detached runtime startup or operator-loop behavior changes beyond consuming
   the new scaffolded file

### Docs

Belongs here:

1. explicit role definitions for `WORKFLOW.md`, `AGENTS.md`, `OPERATOR.md`,
   skills, and code/tests
2. self-hosting and third-party onboarding guidance that points operators at
   the repo-owned playbook

Does not belong here:

1. hidden policy that is only true for one repository but not documented in the
   selected repository
2. a second source of truth that conflicts with the repo-owned playbook

## Layering Notes

- `config/workflow`
  - may stay unchanged or gain only minimal helper reuse for resolving target
    instance-root paths during scaffolding
  - should not own operator policy itself
- `tracker`
  - remains unchanged for this slice
  - should not become the source of repo-specific operator playbook rules
- `workspace`
  - remains unchanged
  - should not absorb operator-doc lookup policy
- `runner`
  - remains unchanged except for existing operator-loop prompt delivery
  - should not infer repo policy from runtime state
- `orchestrator`
  - remains unchanged
  - should not compensate for missing repo-owned operator docs
- `observability`
  - owns clear operator-facing docs/tests for the new playbook contract
  - should not introduce a new hidden durable policy store

## Slice Strategy And PR Seam

Land this as one reviewable PR focused on one seam: make operator policy
repo-owned and bootstrap that repo-owned contract through `symphony init`.

What lands in this PR:

1. one checked-in `OPERATOR.md` for `symphony-ts`
2. one starter `OPERATOR.md` scaffold for third-party repositories
3. init-path changes so a target repo gets both `WORKFLOW.md` and
   `OPERATOR.md`
4. operator prompt/skill/doc updates that consume the selected repository's
   `OPERATOR.md` when present
5. focused tests for scaffolding and operator contract wording

What is deliberately deferred:

1. workflow-frontmatter or structured config for operator policy
2. tracker-enforced requirements that every repository publish `OPERATOR.md`
3. automatic migration tooling for repositories that already have Symphony
   configured
4. broader operator-loop checkpoint redesign

This seam is reviewable because it stays on policy ownership, docs/prompt
contract, and scaffolding. It does not combine tracker changes, orchestration
state changes, or detached-runtime control redesign.

## Operator Policy Resolution Model

This issue does not change long-running orchestration state. The relevant
stateful behavior is how the operator resolves repository-owned policy for a
selected instance and how init scaffolds the repo-owned contract.

### Resolution states

1. `instance-selected`
   - the operator or init command has a resolved target instance root
2. `core-docs-checked`
   - `WORKFLOW.md`, `AGENTS.md`, `README.md`, and nearby docs have been checked
     if present
3. `operator-playbook-found`
   - `<instance-root>/OPERATOR.md` exists and becomes the primary repo-owned
     operator-policy document
4. `operator-playbook-missing`
   - `OPERATOR.md` is absent, so the operator falls back to the checked-in docs
     that do exist plus the generic engine-global operator method
5. `scaffold-written`
   - `symphony init` created both repo-owned contracts
6. `resolution-failed`
   - target path validation, template rendering, or file writes failed

### Allowed transitions

1. `instance-selected -> core-docs-checked`
2. `core-docs-checked -> operator-playbook-found`
3. `core-docs-checked -> operator-playbook-missing`
4. `instance-selected -> resolution-failed`
5. `core-docs-checked -> resolution-failed`
6. `operator-playbook-found -> scaffold-written`
7. `operator-playbook-missing -> scaffold-written`

### Explicit non-changes

1. no new tracker lifecycle kinds
2. no retry, continuation, reconciliation, or lease changes
3. no new durable operator-local state artifacts beyond existing `.ralph/`
   notebooks/status files

## Failure-Class Matrix

| Observed condition                                                                  | Local facts available                      | Repo-owned facts available                    | Expected decision                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Selected instance has `OPERATOR.md`                                                 | selected instance root, file path          | playbook content                              | read `OPERATOR.md` as the primary repo-specific operator-policy source                           |
| Selected instance lacks `OPERATOR.md`                                               | selected instance root                     | `WORKFLOW.md`, `AGENTS.md`, `README.md`, docs | continue with the checked-in docs that exist and the generic engine-global operator method       |
| Self-hosting `symphony-ts` instance is selected                                     | selected instance root equals repo root    | checked-in root `OPERATOR.md`                 | preserve self-hosting behavior, but source repo-specific operator policy from root `OPERATOR.md` |
| `symphony init` targets an empty repository                                         | target path, no existing workflow/playbook | scaffold inputs                               | write both `WORKFLOW.md` and `OPERATOR.md`, then print next-step guidance                        |
| Target repository already has `WORKFLOW.md` or `OPERATOR.md` and `--force` is unset | target path, existing file paths           | scaffold inputs                               | fail clearly without partial overwrite                                                           |
| Operator prompt/skill still carries `symphony-ts`-specific policy after extraction  | prompt/skill text                          | selected instance may have `OPERATOR.md`      | invalid implementation for this issue; repo-specific policy must live in the selected repository |

## Storage / Persistence Contract

1. `<instance-root>/OPERATOR.md` becomes the canonical repo-owned operator-policy
   file when present
2. the engine repository keeps starter template assets for scaffold generation
   under checked-in source control
3. `symphony init` writes only target-repository files and should avoid partial
   creation/overwrite behavior across the two repo-owned contracts
4. no new `.ralph/` or runtime persistence artifacts are introduced for this
   slice

## Observability Requirements

1. init output must make it obvious which files were created or updated
2. operator-facing docs must explicitly state that repo-specific operator policy
   comes from the selected repository's `OPERATOR.md` when present
3. tests must pin the fallback rule for repositories that do not yet publish
   `OPERATOR.md`
4. role-boundary docs should make the relationship among `WORKFLOW.md`,
   `AGENTS.md`, `OPERATOR.md`, skills, and code/tests explicit

## Implementation Steps

1. Add a checked-in root `OPERATOR.md` for `symphony-ts` and move
   `symphony-ts`-specific operator policy there from global operator assets
   where appropriate.
2. Add a focused starter `OPERATOR.md` template for third-party repositories,
   alongside the existing starter workflow template assets.
3. Extend `src/cli/init.ts` and any supporting template helpers so `symphony
init`:
   - resolves the target instance root
   - validates overwrite behavior across both files
   - writes both `WORKFLOW.md` and `OPERATOR.md`
   - renders next-step output that mentions both repo-owned contracts
4. Update operator assets so the selected instance's `OPERATOR.md` is part of
   the required read path when present:
   - [`skills/symphony-operator/SKILL.md`](../../../skills/symphony-operator/SKILL.md)
   - [`skills/symphony-operator/operator-prompt.md`](../../../skills/symphony-operator/operator-prompt.md)
5. Update docs that define repository-owned contracts and third-party/self-host
   onboarding, likely including:
   - [`README.md`](../../../README.md)
   - [`AGENTS.md`](../../../AGENTS.md)
   - [`docs/guides/workflow-guide.md`](../../guides/workflow-guide.md)
   - [`docs/guides/operator-runbook.md`](../../guides/operator-runbook.md)
   - [`docs/guides/self-hosting-loop.md`](../../guides/self-hosting-loop.md)
6. Add or update tests for:
   - init argument/overwrite behavior across both files
   - generated starter `OPERATOR.md` content and scaffold output
   - operator-loop prompt wording for selected-instance `OPERATOR.md`
   - any doc/contract tests that pin the new role boundaries
7. Run local QA:
   - `pnpm format`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - local self-review if a reliable review command is available

## Tests And Acceptance Scenarios

### Unit / Contract

1. `symphony init` resolves the target repository and refuses to overwrite
   either `WORKFLOW.md` or `OPERATOR.md` without `--force`
2. the rendered starter `OPERATOR.md` contains generic repo-owned operator
   guidance instead of `symphony-ts`-specific self-hosting policy
3. scaffold result rendering mentions both repo-owned contract files
4. operator contract tests pin that the selected repository's `OPERATOR.md` is
   part of the required read path when present

### Integration

1. running `symphony init` against a temp target repository creates both
   `WORKFLOW.md` and `OPERATOR.md`
2. operator-loop prompt capture for an external workflow instructs the operator
   to read the selected repository's `OPERATOR.md` rather than relying only on
   engine-global playbook text
3. self-hosting prompt/docs still work when the selected repository is
   `symphony-ts` itself

### End-to-end / User-visible Contract

1. given an empty target repository, when an operator runs `pnpm tsx
bin/symphony.ts init ../target-repo --tracker-repo your-org/your-repo`, then
   the target repo receives both `WORKFLOW.md` and `OPERATOR.md`
2. given a selected external instance with a checked-in `OPERATOR.md`, when the
   operator loop runs against `--workflow <target>/WORKFLOW.md`, then the
   selected repository owns repo-specific operator policy for that cycle
3. given a selected external instance without `OPERATOR.md`, when the operator
   loop runs, then the generic engine-global method remains usable without
   silently importing `symphony-ts`-specific policy
4. given an existing target `WORKFLOW.md` or `OPERATOR.md`, when `--force` is
   omitted, then `symphony init` fails without clobbering the repository's
   current contract files

## Exit Criteria

1. `symphony-ts` has a checked-in root `OPERATOR.md` for self-hosting policy
2. `symphony init` scaffolds both `WORKFLOW.md` and `OPERATOR.md`
3. engine-global operator assets defer repo-specific policy to the selected
   repository's `OPERATOR.md` when present
4. docs clearly explain the roles of `WORKFLOW.md`, `AGENTS.md`, `OPERATOR.md`,
   skills, and code/tests
5. focused tests cover scaffolding, fallback, and operator prompt/contract
   wording

## Deferred To Later Issues Or PRs

1. structured workflow/frontmatter configuration for operator policy
2. automatic migration of existing repositories to add `OPERATOR.md`
3. tracker-side enforcement or warnings for missing operator playbooks
4. broader cleanup or redesign of the operator wake-up algorithm

## Revision Log

- 2026-04-09: Initial plan created for issue `#330` and prepared for plan
  review.
