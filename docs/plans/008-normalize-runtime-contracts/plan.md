# Phase 1.1 Technical Plan: Normalize Runtime Domain and Service Contracts

## Goal

Refactor the working GitHub bootstrap loop into clearer, spec-shaped runtime contracts without breaking the current self-hosting path.

This slice should make the orchestrator depend on normalized domain models and service interfaces instead of Phase 0 bootstrap assumptions.

## Scope

Required outcomes for issue `#8`:

1. define normalized runtime types for issue, workspace, run attempt/session, and retry state
2. separate service interfaces from the current bootstrap adapter implementations
3. make the orchestrator consume explicit contracts where practical
4. preserve the real GitHub bootstrap loop through the existing e2e harness

## Current Gaps

The current Phase 0 code has the right layers, but several boundaries are still too bootstrap-shaped:

- `src/domain/types.ts` mixes workflow config, runtime state, and adapter-facing types in one file
- `Tracker`, `WorkspaceManager`, and `Runner` interfaces still expose bootstrap-specific assumptions
- the orchestrator renders prompts directly and decides success by calling a GitHub-specific `hasPullRequest`
- retry bookkeeping is implicit inside the orchestrator rather than modeled as runtime state
- workspace creation still takes raw config and hooks on each call instead of a normalized workspace request

## Design Direction

### 1. Normalize runtime domain types

Introduce explicit runtime models under `src/domain/` for:

- issue identity and issue state
- workspace key and prepared workspace session data
- run attempt / run session lifecycle
- retry state and retry scheduling

These types should remain tracker-agnostic and runner-agnostic.

### 2. Separate service contracts from adapter configuration

Refactor the service interfaces so the orchestrator depends on stable operations:

- tracker service owns claim, release, fail, complete, and post-run verification
- workspace service owns workspace preparation and cleanup
- runner service owns launching a run attempt against a prepared workspace

Bootstrap-specific details such as GitHub labels, branch-to-PR verification, repo cloning, and shell command execution stay inside the concrete adapters.

### 3. Move prompt rendering to the workflow/config boundary

The orchestrator should consume a rendered prompt builder contract instead of calling workflow helpers directly.

That keeps prompt construction outside runner behavior and makes the runtime contract clearer.

### 4. Make orchestrator state explicit

Refactor the orchestration loop around typed runtime state:

- running issue ids
- active run sessions
- retry entries keyed by issue id

This is still in-memory for Phase 1.1, but the state shape should be explicit and testable.

## Implementation Plan

### 1. Domain split

Create or reshape domain modules for:

- `issue`
- `workspace`
- `run`
- `retry`
- workflow/config types that remain repository-owned

Keep the types small and explicit rather than rebuilding one large shared file.

### 2. Contract refactor

Update the interfaces in:

- `src/tracker/service.ts`
- `src/workspace/service.ts`
- `src/runner/service.ts`

Target changes:

- tracker returns normalized issue models
- tracker exposes post-run completion verification behind its own contract
- workspace prepare call accepts a normalized workspace request and returns prepared workspace info
- runner launch call accepts a normalized run attempt context and returns a normalized run result

### 3. Bootstrap adapter migration

Update the existing implementations so they satisfy the new contracts:

- GitHub bootstrap tracker performs branch/PR verification internally
- local workspace manager prepares deterministic issue workspaces and returns normalized workspace info
- local runner launches against the normalized run attempt context

### 4. Orchestrator refactor

Update the orchestrator to:

- use the normalized service interfaces
- store explicit runtime state and retry entries
- treat failures through a shared failure path
- preserve current concurrency and retry behavior

### 5. Test coverage

Add or update tests for:

- normalized domain and workflow prompt context shape
- orchestrator concurrency and retry behavior under the new contracts
- GitHub bootstrap tracker verification and lifecycle behavior
- e2e GitHub bootstrap flow to confirm the loop still works

## Risks

### Contract drift

Avoid introducing abstractions that the current bootstrap flow does not actually need. The contracts should be clearer, not more speculative.

### Hidden GitHub assumptions

The current success check is PR-based. That policy should move behind the tracker contract rather than disappear.

### Refactor regressions

The branch/workspace retry path is already covered by the e2e harness and must remain green.

## Exit Criteria

This issue is complete when:

1. the runtime domain is split into clearer normalized contracts
2. the orchestrator uses explicit service interfaces instead of bootstrap-specific assumptions
3. unit, integration, and e2e tests cover the refactor
4. the GitHub bootstrap path still works locally end-to-end
