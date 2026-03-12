# Architecture

`symphony-ts` should track the Symphony spec closely enough that the spec remains the primary architecture reference.

## Layer Stack

```text
CLI
  -> Workflow / Config
  -> Tracker
  -> Workspace
  -> Runner
  -> Orchestrator
  -> Observability
```

This ordering is logical, not an excuse for tight coupling. Each layer should expose a narrow service contract.

## Spec Abstraction Levels

`SPEC.md` describes Symphony in these abstraction levels:

1. Policy Layer
2. Configuration Layer
3. Coordination Layer
4. Execution Layer
5. Integration Layer
6. Observability Layer

In `symphony-ts`, use this local mapping when `SPEC.md` is not present in the clone:

- Policy Layer: `WORKFLOW.md`, issue plans, and repository-owned guidance
- Configuration Layer: workflow loading, parsing, and typed config resolution under `src/config/`
- Coordination Layer: orchestrator polling, retries, reconciliation, and runtime state under `src/orchestrator/`
- Execution Layer: workspace lifecycle plus runner process control under `src/workspace/` and `src/runner/`
- Integration Layer: tracker adapters, transport, and normalization under `src/tracker/`
- Observability Layer: structured logs and operator-facing status surfaces under `src/observability/`

The CLI is bootstrap wiring around these layers, not a replacement for them.

## Core Layers

### CLI

Responsible for:

- process startup
- environment/bootstrap wiring
- loading the runtime
- graceful shutdown handling

The CLI should stay thin.

### Workflow / Config

Responsible for:

- locating `WORKFLOW.md`
- parsing front matter and prompt body
- rendering prompt templates
- resolving typed runtime settings

This layer defines the repository-owned runtime contract.

### Tracker

Responsible for:

- reading eligible work
- claiming and releasing work
- refreshing current issue state
- completing or handing off work according to tracker policy

Tracker implementations must normalize external data into a stable internal issue model.

### Workspace

Responsible for:

- deterministic workspace paths
- workspace creation and reuse
- lifecycle hooks such as `after_create`
- cleanup policy

This layer owns filesystem preparation, not tracker policy.

### Runner

Responsible for:

- launching coding agents
- reporting provider-neutral execution events and final results
- timeout and cancellation behavior

The runner should not own prompt construction or tracker mutations. Codex is the
current local adapter behind that contract, not a shape the orchestrator should
depend on.

### Orchestrator

Responsible for:

- polling
- concurrency limits
- runtime state
- dispatch decisions
- retries
- reconciliation
- shutdown behavior

This is the control plane of the application.

### Observability

Responsible for:

- structured logs
- operation boundaries / spans
- operator-facing runtime context

Keep this layer thin and composable.

## Domain Shape

The internal runtime should converge on a small set of normalized concepts:

- `Issue`
- `WorkflowDefinition`
- `ResolvedConfig`
- `WorkspaceInfo`
- `RunAttempt`
- `RunnerEvent`
- `RunResult`
- `RetryEntry`
- `OrchestratorState`

Adapters can hold extra data internally, but the orchestrator should consume stable internal types.

## Dependency Rules

1. The orchestrator depends on service interfaces, not concrete adapters.
2. Trackers do not reach upward into orchestrator logic.
3. Runners do not render prompts or manipulate tracker state.
4. Workspaces do not decide dispatch policy.
5. Observability should be injectable across the system.
6. Tests may wire layers however they need, but production code should respect the service boundaries.

## Phase Guidance

### Phase 0

Build the minimum real loop:

- bootstrap GitHub tracker
- local workspace
- local runner
- single-process orchestrator

### Phase 1

Stabilize runtime contracts:

- normalize domain types
- tighten service interfaces
- make orchestrator state explicit

### Phase 2 and beyond

Extend at the edges first:

- Beads adapter
- runner variations
- Context Library hooks
- remote execution

Do not let future integrations distort the core runtime before they have earned that complexity.

## Decision Records

Architectural decisions that need durable justification should be recorded in `docs/adrs/`.
