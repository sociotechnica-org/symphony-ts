# Issue 339 Plan: Split Workflow Loading, Typed Config Resolution, and Prompt Rendering Into Dedicated Modules

## Status

- plan-ready

## Goal

Refactor the workflow/config implementation so workflow file loading, typed config resolution, tracker-specific config resolution, and prompt rendering each live behind dedicated modules instead of accumulating in one large `src/config/workflow.ts` file, while preserving the current `WORKFLOW.md` contract and keeping the public workflow-loading API stable.

## Scope

1. split workflow file reading/frontmatter parsing from typed config resolution
2. split top-level config resolution into dedicated section helpers for tracker, polling, workspace, hooks, agent, and observability
3. isolate GitHub and Linear tracker config resolution from generic workflow parsing
4. move prompt rendering, continuation rendering, and prompt-safe config redaction behind a dedicated prompt-builder module
5. keep environment override, repo URL policy, and instance-path derivation explicit and testable behind focused config modules
6. preserve existing exported workflow-loading and prompt-builder behavior unless a narrow compatibility shim is required
7. update docs/tests that currently imply all workflow parsing and prompt-building logic live in one file

## Non-goals

1. changing the `WORKFLOW.md` schema or defaults
2. changing Liquid templating behavior or prompt trust-boundary semantics
3. redesigning CLI behavior for `run`, `init`, `status`, or factory control
4. changing tracker lifecycle policy, orchestrator retry behavior, or runner execution behavior
5. introducing hot reload or config reapply features beyond creating cleaner seams for future work

## Current Gaps

1. `src/config/workflow.ts` mixes file I/O, YAML parsing, value validation, env overrides, instance-path derivation, tracker/provider-specific config resolution, prompt redaction, and prompt rendering
2. section-specific config logic is difficult to extend because generic parsing and provider-specific policy helpers sit in the same module
3. prompt-building behavior and continuation text are maintained beside YAML parsing even though they consume an already resolved workflow definition
4. docs such as the workflow guide and frontmatter reference point readers at one implementation file even though the issue requires multiple architectural seams
5. current tests verify behavior well, but the module structure makes it harder to add targeted tests for loader vs resolver vs prompt-builder boundaries

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: preserving `WORKFLOW.md` as the repository-owned runtime contract and keeping prompt trust-boundary behavior unchanged
  - does not belong: hiding runtime invariants inside new helper modules or changing repository-owned policy text as part of a refactor
- Configuration Layer
  - belongs: workflow file loading, frontmatter parsing, typed config resolution, env overrides, repo/path policy, and the prompt-builder seam that consumes resolved workflow data
  - does not belong: tracker transport, orchestrator retry decisions, or runner subprocess policy
- Coordination Layer
  - belongs: no coordination behavior changes in this slice beyond continuing to consume the same `WorkflowDefinition` / `PromptBuilder` contracts
  - does not belong: YAML parsing, prompt rendering, or tracker/provider config parsing
- Execution Layer
  - belongs: no execution changes beyond continuing to receive prompts from the same `PromptBuilder` contract
  - does not belong: moving prompt rendering into runner adapters or workspace code
- Integration Layer
  - belongs: tracker-specific config resolution helpers for GitHub and Linear as config-edge integration seams
  - does not belong: generic frontmatter parsing or prompt-template rendering
- Observability Layer
  - belongs: doc/test updates if workflow-config observability examples or references need to follow the new seams
  - does not belong: introducing new status surfaces or logging formats in a refactor-only slice

## Architecture Boundaries

### Belongs in this issue

1. a thin public workflow entry module
   - keep `src/config/workflow.ts` as the stable import surface for `loadWorkflow`, `loadWorkflowInstancePaths`, `loadWorkflowWorkspaceRoot`, and `createPromptBuilder`
   - delegate implementation into dedicated internal modules so call sites do not churn broadly
2. workflow source/loading modules
   - file read + frontmatter parsing + typed raw workflow shape
   - instance/workspace-path derivation helpers that only depend on workflow-owned inputs
3. config resolution modules
   - one coordinator module for assembling `ResolvedConfig`
   - focused section resolvers for tracker, polling, workspace, hooks, agent, and observability
   - focused shared validation helpers instead of scattering boundary parsing across many files
4. tracker-specific config modules
   - GitHub-backed tracker resolution in one focused module
   - Linear tracker resolution in one focused module
   - shared tracker-kind / queue-priority / plan-review parsing only where it is genuinely shared
5. prompt-builder module
   - prompt-safe config projection
   - Liquid rendering of the initial prompt
   - continuation prompt rendering
6. docs/tests
   - update workflow docs that currently describe one-file ownership
   - add or adjust targeted unit coverage for the new seams while preserving existing end-to-end behavior

### Does not belong in this issue

1. changing any normalized tracker lifecycle, handoff, retry, or review semantics
2. moving prompt-context shaping out of `src/tracker/prompt-context.ts`
3. redesigning `ResolvedConfig`, `WorkflowDefinition`, or prompt input domain types unless a minimal compatibility tweak is required
4. broad call-site rewrites across CLI, orchestrator, observability, or tests when a façade module can preserve current imports
5. tracker transport refactors or new provider features hidden inside this structural refactor

## Layering Notes

- `config/workflow`
  - owns the stable public workflow-loading surface
  - does not remain the dumping ground for all loader, resolver, and prompt code
- `config/workflow-source`
  - owns file reading and frontmatter parsing
  - does not own tracker/provider-specific config resolution or prompt rendering
- `config/resolution`
  - owns typed config assembly from raw frontmatter plus env overrides
  - does not own tracker prompt-context shaping or orchestration policy
- `config/tracker-*`
  - owns tracker-specific config parsing at the configuration boundary
  - does not own tracker API transport or runtime lifecycle decisions
- `config/prompt-builder`
  - owns prompt-safe config projection, initial prompt rendering, and continuation rendering
  - does not own workflow file loading or YAML validation
- `tracker`
  - continues to own prompt-context normalization from tracker-authored data
  - does not absorb workflow-template rendering concerns
- `runner`, `workspace`, `orchestrator`, `observability`
  - continue consuming the same resolved workflow/prompt contracts
  - do not pick up config parsing logic in this slice

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one explicit seam: restructure the workflow/config subsystem into dedicated internal modules while preserving the current external behavior and import surface.

This stays reviewable because the PR is intentionally limited to:

1. internal module decomposition under `src/config/`
2. minimal doc updates where the current implementation path is part of the checked-in guidance
3. test updates that prove behavior stayed stable and the new seams are covered

This issue should not expand into contract redesign or unrelated behavior changes. If the refactor uncovers a behavior bug that must be fixed to keep the split correct, fix it in the same PR only if the change is directly tied to the new boundary and can be described clearly in the updated plan.

## Runtime State Model

No orchestration state machine changes are expected in this slice.

The relevant runtime contract remains:

1. raw `WORKFLOW.md` source is read from disk
2. frontmatter/body are parsed into a raw workflow definition
3. raw workflow plus env overrides resolve into `ResolvedConfig`
4. `ResolvedConfig` plus prompt template form `WorkflowDefinition`
5. `PromptBuilder` renders initial and continuation prompts from that definition

The refactor should make those stages explicit in modules and tests, but it must not introduce new orchestrator-visible states.

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized config facts available | Expected decision |
| --- | --- | --- | --- |
| `WORKFLOW.md` cannot be read | workflow path only | none | fail in workflow-source loader with `WorkflowError`; no partial config resolution |
| frontmatter is malformed YAML or not a mapping | raw file source available | none | fail in parsing module before section resolvers run |
| a section field is invalid, such as `tracker.repo` or `agent.timeout_ms` | parsed raw frontmatter | section-local raw values | fail in the relevant section resolver with `ConfigError`; no prompt-builder involvement |
| `SYMPHONY_REPO` overrides a GitHub-backed tracker repo | env + parsed tracker section | resolved tracker config | preserve existing override behavior and warnings through the resolution seam |
| prompt template references an unknown variable/filter | `WorkflowDefinition` already resolved | redacted prompt-safe config + prompt inputs | fail in prompt-builder render path with `WorkflowError`; config resolution stays separate |
| a caller only needs instance paths | workflow path + raw frontmatter workspace root | no full `ResolvedConfig` needed | use the dedicated instance-path loader without forcing prompt-builder creation or full config assembly |

## Storage / Persistence Contract

1. `WORKFLOW.md` remains the only repository-owned configuration source for this slice
2. `ResolvedConfig`, `WorkflowDefinition`, and `PromptBuilder` remain in-memory runtime contracts only
3. no new durable state files or caches should be introduced

## Observability Requirements

1. existing error messages and warning paths for workflow load/config resolution should remain inspectable and stable unless a boundary-specific improvement is necessary
2. docs should make the new workflow/config seams legible to future contributors instead of pointing only at a single hot file
3. test coverage should make loader, resolver, and prompt-builder failures distinguishable

## Implementation Steps

1. create a thin `src/config/workflow.ts` façade that re-exports the existing public workflow API from dedicated internal modules
2. extract workflow source loading into a focused module
   - read file contents
   - parse frontmatter/body
   - expose the parsed raw workflow shape
3. extract instance/workspace-path loading into a focused module that depends only on raw workflow inputs plus `src/domain/workflow.ts`
4. extract config resolution into a coordinator module plus focused section resolvers for:
   - tracker
   - polling
   - workspace
   - hooks
   - agent
   - observability
5. split tracker resolution so GitHub-backed and Linear-specific parsing live in dedicated config modules instead of one shared hot file
6. move prompt-safe config redaction, Liquid rendering, and continuation rendering into a dedicated prompt-builder module that consumes `WorkflowDefinition`
7. keep shared validation helpers in one focused config-boundary helper module instead of repeating coercion/parsing logic across section files
8. update docs that currently point readers to `src/config/workflow.ts` as the single implementation site so they describe the new module split accurately
9. update tests so:
   - existing workflow behavior remains green
   - at least one new targeted test exercises loader/resolver/prompt-builder seams directly if the current suite does not already cover them adequately

## Tests And Acceptance Scenarios

### Unit

1. workflow-source loader still rejects missing or malformed frontmatter exactly at the file/parsing boundary
2. section resolvers still preserve current defaults and validation for tracker, polling, workspace, agent, and observability fields
3. GitHub and Linear tracker config resolution still preserve current env-override and validation behavior after extraction
4. prompt-builder still redacts config appropriately and renders both initial and continuation prompts with the same semantics as today
5. instance-path loading still resolves instance roots and workspace roots without requiring full workflow resolution

### Integration

1. CLI/integration paths that call `loadWorkflow` and `createPromptBuilder` continue working without import-surface churn
2. GitHub bootstrap and Linear integration suites still render prompts from resolved workflows after the split

### End-to-end

1. existing bootstrap-factory and linear-factory end-to-end tests remain green without workflow contract changes

### Local Gate

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. local self-review if a reliable review path is available

## Exit Criteria

1. workflow file loading, typed config resolution, and prompt building are implemented in distinct modules under `src/config/`
2. tracker-specific config parsing is separated from generic workflow parsing
3. `src/config/workflow.ts` is reduced to a stable façade or other comparably thin public entrypoint
4. existing `WORKFLOW.md` behavior stays unchanged unless an explicitly documented bug fix is required
5. docs no longer imply that all workflow/config behavior lives in one implementation file
6. local format, lint, typecheck, and test gates pass

## Deferred Work

1. any `WORKFLOW.md` schema redesign or hot-reload behavior built on top of these seams
2. broader prompt-context refactors across tracker and runner layers
3. contract changes to CLI workflow commands
4. additional config-system cleanup that is not required to make the loader/resolver/prompt-builder split reviewable

## Decision Notes

1. Preserve the current public imports through a thin façade so this refactor improves module ownership without forcing a broad cross-repo rewrite.
2. Keep prompt rendering in a dedicated config-adjacent module rather than moving it into runners; prompt construction still depends on the repository-owned workflow contract, not runner transport.
3. Split tracker-specific config parsing into dedicated modules because provider-specific parsing is the clearest current edge inside the config layer.
4. Centralize boundary parsing helpers instead of duplicating them per section so the refactor reduces, rather than spreads, validation complexity.

## Revision Log

- 2026-04-09: Initial plan created for issue `#339` after reviewing `AGENTS.md`, `README.md`, `docs/architecture.md`, workflow docs, current `src/config/workflow.ts`, and the existing workflow test surface.
