# Issue 35 Plan: Multi-Model Runner Support Metadata For Generic Command Backends

## Status

- approved

## Goal

Keep Symphony's execution boundary open to additional local backends after the provider-neutral runner contract is proven by making `generic-command` runs observable with explicit provider/model metadata, without reopening orchestrator or tracker seams.

## Scope

- extend `agent.runner.kind: generic-command` with optional repo-owned metadata fields for provider and model identity
- thread that metadata through workflow parsing and the generic-command runner session description
- preserve current default behavior when the metadata is omitted
- add tests that prove the config seam, runner metadata emission, and end-to-end artifact visibility
- update operator docs and checked-in examples so arbitrary generic backends such as Pi are configured explicitly

## Non-goals

- adding another first-class runner adapter in this issue
- changing orchestrator continuation, retry, reconciliation, lease, or handoff policy
- tracker transport, normalization, or policy changes
- dynamic per-issue backend routing or automatic backend fallback
- redesigning the provider-neutral runner contract
- generic capability negotiation across backends

## Current Gaps

- `generic-command` currently reports a fixed session provider of `generic-command` and a `null` model, even when the underlying CLI is a distinct backend
- workflow config has no typed place to declare repo-owned metadata for generic local CLIs
- status, artifacts, and reports therefore cannot distinguish a Pi-backed generic command from any other arbitrary subprocess
- the current execution seam is otherwise already in place on `main`: provider-neutral runner contract, workflow-owned runner selection, and first-class Codex/Claude adapters exist already

## Decision Notes

- Narrow `#35` to metadata for arbitrary generic backends instead of reopening the already-landed runner-contract and backend-selection work.
- Keep the seam in configuration plus execution only. The orchestrator should continue consuming the same normalized runner session shape.
- Prefer explicit workflow-owned metadata over command-string heuristics for future backends. Heuristics can stay as defaults elsewhere, but repo-owned identity should be inspectable in `WORKFLOW.md`.
- Preserve backward compatibility by keeping `generic-command` / `null` as the default emitted metadata when no explicit values are configured.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the repo-owned rule that arbitrary generic backends declare their observable identity in `WORKFLOW.md`
  - does not belong: subprocess launch details or tracker policy
- Configuration Layer
  - belongs: typed parsing and validation of optional generic-command provider/model metadata
  - does not belong: process spawning, session lifecycle, or tracker writes
- Coordination Layer
  - belongs: untouched in this slice; it keeps consuming normalized runner session descriptions
  - does not belong: branching on generic backend identity
- Execution Layer
  - belongs: generic-command runner session description and metadata emission
  - does not belong: prompt rendering, retry policy, or tracker mutations
- Integration Layer
  - belongs: untouched in this slice
  - does not belong: runner metadata config
- Observability Layer
  - belongs: existing status/artifact/report surfaces consuming the richer normalized metadata without schema redesign
  - does not belong: backend-specific parsing logic

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - add typed optional metadata fields for `generic-command`
- `src/config/workflow.ts`
  - parse and validate those fields
- `src/runner/generic-command.ts`
  - emit normalized provider/model metadata from config
- tests
  - workflow config coverage
  - runner contract/factory coverage
  - one end-to-end artifact/status assertion path
- docs
  - README and `WORKFLOW.md` examples for explicit generic backend metadata

### Does not belong in this issue

- new runner kinds
- orchestration-state refactors
- tracker changes
- workspace lifecycle changes
- broader provider capability modeling beyond provider/model labels

## Layering Notes

- `config/workflow`
  - owns repo-owned metadata parsing
  - should not infer tracker or orchestrator behavior from that metadata
- `runner`
  - owns turning config metadata into normalized session descriptions
  - should not mutate tracker state or prompt content
- `orchestrator`
  - remains backend-agnostic
  - should not branch on generic provider/model labels
- `observability`
  - consumes normalized session metadata already present in the runner contract
  - should not become a second config parser

## Slice Strategy And PR Seam

This issue stays reviewable as one PR by limiting the seam to:

1. typed workflow metadata for `generic-command`
2. generic runner session-description emission
3. targeted tests and docs

This avoids mixing:

- another runner adapter
- orchestrator policy changes
- tracker or workspace seams
- remote execution or routing policy

## Runtime State Model

No new orchestrator runtime state machine is required. This issue does not change retries, continuations, reconciliation, leases, or handoff states.

## Validation Matrix

| Observed input / condition                               | Boundary facts available           | Expected decision                                                                               |
| -------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `generic-command` configured without metadata            | workflow front matter              | load successfully; emit default provider/model metadata                                         |
| `generic-command` configured with provider only          | workflow front matter              | load successfully; emit explicit provider with `model: null`                                    |
| `generic-command` configured with provider and model     | workflow front matter              | load successfully; emit both through session descriptions                                       |
| generic command run completes successfully               | runner config and execution result | status/artifacts show configured provider/model                                                 |
| non-generic runner kind includes generic metadata fields | runner kind plus parsed fields     | ignore by construction because those fields belong only to the `generic-command` config variant |

## Observability Requirements

- keep `RunnerSessionDescription` unchanged
- ensure generic-command sessions can publish explicit provider/model values
- preserve backward-compatible defaults when metadata is omitted
- keep issue artifacts, status snapshots, and reports readable without additional schema changes

## Implementation Steps

1. Add optional `provider` and `model` fields to the `generic-command` workflow config type.
2. Parse and validate those fields in `src/config/workflow.ts`.
3. Update `GenericCommandRunner` to emit provider/model metadata from config with backward-compatible defaults.
4. Add tests for workflow parsing, runner construction/session description, and one e2e artifact path.
5. Update README and `WORKFLOW.md` examples to show explicit metadata for arbitrary generic backends such as Pi.

## Tests And Acceptance Scenarios

### Unit tests

- workflow config accepts `generic-command` with explicit `provider`
- workflow config accepts `generic-command` with explicit `provider` and `model`
- generic-command runner emits configured provider/model through `describeSession()`
- generic-command runner keeps the current default metadata when those fields are omitted

### Integration / end-to-end coverage

- keep existing generic-command factory/e2e paths green
- add one e2e assertion that issue artifacts record configured generic provider/model metadata

### Acceptance scenarios

1. A workflow can select `generic-command` and declare `provider: pi`.
2. A generic-command run surfaces `provider: pi` in normalized session metadata without orchestrator changes.
3. A workflow can optionally declare a model label for the same backend.
4. Existing generic-command workflows without metadata continue to emit the current default shape.

## Exit Criteria

- `WORKFLOW.md` supports explicit provider/model metadata for `generic-command`
- generic-command runs emit that metadata through the existing runner session contract
- tests cover parsing, default behavior, and artifact visibility
- docs show the supported config shape clearly enough for future backends

## Deferred To Later Issues Or PRs

- first-class adapters for additional providers beyond Codex and Claude
- dynamic backend routing or fallback based on token pressure or issue labels
- richer capability metadata beyond provider/model identity
- remote or hosted runner implementations
