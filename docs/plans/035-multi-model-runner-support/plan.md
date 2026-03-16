# Issue 35 Plan: Generic Runner Metadata For Multi-Backend / Multi-Model Support

## Status

- plan-ready

## Goal

Close the remaining gap in Symphony's multi-model runner story by extending the existing `generic-command` runner path so arbitrary local backends and model choices remain visible, typed, and configurable without requiring orchestrator changes for each new CLI.

## Scope

- add a repo-owned config seam for generic runner metadata under `agent.runner`
- let `generic-command` publish normalized backend/provider and optional model metadata instead of always collapsing to `provider: "generic-command"`
- keep the provider-neutral runner contract intact while making non-first-class backends such as Pi observable through the same execution path
- add focused workflow parsing, runner-factory, runner-contract, and e2e coverage for generic backends with explicit metadata
- update docs so the supported path for backend/model choice beyond Codex and Claude is inspectable in `WORKFLOW.md`

## Non-goals

- adding a new first-class runner adapter for Pi or any other specific provider
- dynamic per-issue backend routing or fallback policy
- orchestration retry, continuation, reconciliation, or lease changes
- tracker transport, normalization, or policy changes
- remote/background execution providers
- richer provider capability modeling such as per-backend feature matrices beyond metadata surfaced by this slice

## Current Gaps

- `#89`, `#90`, `#91`, and `#114` already landed the provider-neutral runner contract, workflow runner selection, and first-class Codex / Claude adapters
- `generic-command` can already execute arbitrary CLIs, but its session metadata is currently fixed to `provider: "generic-command"` and `model: null`
- because the generic path hides the underlying backend/model identity, status surfaces, artifacts, and reports cannot distinguish a Pi run from any other raw command run
- this means Symphony is no longer Codex-only in execution capability, but the generic path does not yet give operators a repo-owned, inspectable contract for backend/model choice beyond the built-in first-class adapters

## Decision Notes

- The current issue should not reopen the broader runner-contract work; that already landed.
- The reviewable seam is config plus execution-layer metadata, not another runner implementation.
- `generic-command` should stay the escape hatch for new local CLIs, but it should surface explicit identity metadata when the workflow owner knows what backend and model they are invoking.
- Keep the metadata contract optional and narrow:
  - default to a sensible provider identity when no metadata is supplied
  - allow an explicit provider/backend label
  - allow an optional model label
- Do not teach the orchestrator or tracker about provider-specific behavior. They should keep consuming normalized runner session descriptions only.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the repo-owned rule that backend/model choice outside first-class adapters should remain a runner concern expressed through `WORKFLOW.md`
  - does not belong: subprocess launch details or tracker lifecycle behavior
- Configuration Layer
  - belongs: typed parsing and validation for generic runner metadata under `agent.runner`
  - does not belong: process spawning, prompt rendering, or tracker mutations
- Coordination Layer
  - belongs: unchanged consumption of normalized runner session metadata
  - does not belong: branches for Pi, Opus, or any other provider/model choice
- Execution Layer
  - belongs: generic runner session description, metadata defaults, and normalized result/session reporting
  - does not belong: tracker policy, retry decisions, or workflow prompt construction
- Integration Layer
  - belongs: untouched in this slice
  - does not belong: generic runner metadata or backend/model selection
- Observability Layer
  - belongs: surfacing normalized provider/model metadata already emitted by the runner contract
  - does not belong: guessing backend/model identity from raw command strings or logs

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - extend the generic runner config variant with explicit metadata fields
- `src/config/workflow.ts`
  - parse and validate the generic runner metadata seam
- `src/runner/generic-command.ts`
  - publish normalized provider/model metadata from config instead of a hard-coded generic label
- `src/runner/factory.ts`
  - keep wiring unchanged except for consuming the expanded typed config
- tests
  - workflow parsing tests
  - generic runner/session description tests
  - runner-factory coverage
  - one e2e path proving explicit generic metadata survives through the observable factory flow
- docs
  - README and `WORKFLOW.md` examples for arbitrary local backends via `generic-command`

### Does not belong in this issue

- new runner subclasses for provider-specific CLIs
- orchestrator runtime-state refactors
- tracker adapter changes
- workspace lifecycle changes
- report-enricher redesign

## Layering Notes

- `config/workflow`
  - owns the typed metadata contract and validation for generic backends
  - does not infer provider/model identity later from runtime logs
- `tracker`
  - remains isolated from runner metadata policy
  - does not special-case generic backends
- `workspace`
  - continues to provide filesystem context only
  - does not decide backend/model identity
- `runner`
  - owns publishing normalized provider/model session metadata
  - does not make orchestration or tracker policy decisions
- `orchestrator`
  - keeps consuming a `Runner` plus normalized session descriptions
  - does not branch on provider/model values
- `observability`
  - shows whatever normalized metadata the runner supplies
  - does not parse command strings to recover provider/model identity heuristically

## Slice Strategy And PR Seam

This should land as one reviewable PR by limiting the seam to config, generic-runner metadata, tests, and docs:

1. extend typed workflow config for generic backend/model metadata
2. update the generic runner to emit that metadata
3. prove the seam with focused tests and one e2e scenario
4. document how arbitrary local CLIs use this path

This is reviewable because it does not combine:

- another first-class runner adapter
- orchestrator state changes
- tracker or workspace refactors
- dynamic routing policy

Follow-up issues can still add dedicated adapters for providers that need special continuation or command validation, but simple backend/model choice should not require them.

## Runtime State Model

This issue does not change retries, continuations, reconciliation, leases, or handoff states, so no new orchestrator runtime state machine is required.

The execution-layer session lifecycle remains the existing runner contract:

- `idle -> starting -> running -> completed|failed -> closed`

Additional rule for this slice:

- generic runner metadata is resolved once from validated workflow config and remains stable for the lifetime of the runner instance

## Failure-Class Matrix

| Observed condition                                                     | Boundary facts available                     | Expected decision                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| `agent.runner.kind: generic-command` omits custom metadata            | workflow config, parsed command              | load successfully and fall back to default generic provider identity              |
| generic metadata provides a non-empty provider and optional model      | workflow config                              | load successfully and publish that normalized metadata in session descriptions     |
| generic metadata provider is empty or malformed                        | workflow config                              | fail workflow loading with `ConfigError` before runtime wiring                    |
| generic command executes successfully with explicit provider metadata   | runner config, subprocess result             | preserve the configured provider/model in status/artifacts without orchestrator changes |
| generic command executes successfully without explicit metadata         | runner config, subprocess result             | preserve backward-compatible generic provider identity                            |
| operator wants a new backend that does not need special session logic  | workflow config only                         | use `generic-command` with explicit metadata instead of adding a new adapter       |

## Observability Requirements

- status and issue artifacts should surface explicit provider/model metadata for generic backends when configured
- existing provider-neutral session/result contracts must remain unchanged outside the metadata values
- no observability component should need to inspect raw `agent.command` to learn the backend/model identity
- docs should show how operators make Pi-like or model-specific runs inspectable without code changes

## Implementation Steps

1. Extend `AgentRunnerConfig` so `generic-command` can carry explicit provider/model metadata.
2. Update workflow parsing to validate and resolve the metadata fields with backward-compatible defaults.
3. Update `GenericCommandRunner.describeSession()` so session descriptions emit the resolved provider/model values.
4. Add or update tests for:
   - workflow parsing and validation of generic metadata
   - generic runner session descriptions with and without explicit metadata
   - runner-factory behavior with expanded generic config
   - one e2e path proving the configured metadata reaches observable factory artifacts/status
5. Update README and `WORKFLOW.md` examples to document the generic multi-backend/model path.

## Tests And Acceptance Scenarios

### Unit tests

- `loadWorkflow()` accepts `agent.runner.kind: generic-command` with explicit provider metadata and optional model metadata
- `loadWorkflow()` rejects malformed generic metadata such as an empty provider label
- `GenericCommandRunner.describeSession()` publishes explicit provider/model metadata when configured
- `GenericCommandRunner.describeSession()` preserves backward-compatible defaults when metadata is omitted
- `createRunner()` still returns `GenericCommandRunner` for the generic path with the expanded config

### Integration / end-to-end coverage

- keep existing Codex, Claude, and generic-command tests green
- add one focused e2e path that configures `generic-command` with explicit provider/model metadata and asserts the resulting session visibility/artifacts reflect that metadata

### Acceptance scenarios

1. A workflow can run an arbitrary CLI through `generic-command` and explicitly identify it as a backend such as Pi without adding a new orchestrator branch.
2. A workflow can surface a model label such as Opus or another provider-specific model on the same generic path.
3. Existing generic-command workflows continue to work without any required config changes.
4. Status surfaces and artifacts show the configured provider/model identity for generic runs.

## Exit Criteria

- arbitrary local CLI backends can be made observable through `generic-command` with repo-owned config
- no orchestrator changes are required to surface provider/model identity for those backends
- backward compatibility is preserved for existing generic-command workflows
- tests cover config parsing, runner metadata emission, and one observable end-to-end path
- docs explain the multi-backend/model path clearly enough that operators do not need a new runner implementation for simple CLI swaps

## Deferred To Later Issues Or PRs

- first-class adapters for providers that need special continuation or command validation
- automatic backend routing based on issue labels, token pressure, or cost policy
- richer provider capability metadata such as continuation support flags or streaming-event capabilities
- report enrichment for provider-specific generic-command logs
