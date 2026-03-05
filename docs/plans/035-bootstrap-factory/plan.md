# Phase 0 Technical Plan: Bootstrap Factory

## Goal

Build the smallest real `symphony-ts` that can:

1. load a repository-owned `WORKFLOW.md`,
2. poll GitHub for eligible issues,
3. create an isolated workspace for one issue,
4. launch a real coding agent command,
5. and let that agent produce a PR against `symphony-ts`.

This phase is about proving the loop end-to-end, not finalizing every abstraction.

## Acceptance Criteria

The phase is complete when all of the following are true:

1. A GitHub issue on `sociotechnica-org/symphony-ts` can be marked ready via the bootstrap GitHub policy.
2. `symphony-ts` detects the issue, claims it, and prevents duplicate dispatch.
3. A workspace is created for that issue and populated by cloning the target repository.
4. A real agent command is launched inside that workspace with a rendered prompt.
5. The agent can make changes and open a PR back to `symphony-ts`.
6. Symphony updates the issue according to the bootstrap policy and emits structured JSON logs.
7. The happy path is covered by an automated integration harness, even if the final ouroboros check is manual.

## Non-Goals

- Beads as the primary tracker
- Molecule-aware dispatch
- Remote execution
- Full restart recovery
- Deep Context Library integration
- Multiple runner implementations

## Bootstrap Architecture

The Phase 0 code should already follow the eventual layer split, but with the minimum number of capabilities in each layer:

```text
CLI
  -> Workflow / Config
  -> Tracker (bootstrap GitHub)
  -> Workspace
  -> Runner
  -> Orchestrator
  -> Observability
```

## Implementation Workstreams

### 1. Repository Scaffold

Create the minimum repo skeleton:

```text
bin/
  symphony.ts
docs/
  architecture.md
  golden-principles.md
  plans/
    035-bootstrap-factory/plan.md
    036-core-runtime-contracts/plan.md
src/
  cli/
  config/
  observability/
  orchestrator/
  runner/
  tracker/
  workspace/
WORKFLOW.md
AGENTS.md
```

Deliverables:

- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `eslint.config.js`
- GitHub Actions CI

### 2. Workflow Loader

Implement a narrow Phase 0 workflow contract:

- load `WORKFLOW.md` from the current repo root
- parse YAML front matter plus markdown body
- support strict prompt rendering using Liquid
- fail dispatch when the file is missing or invalid

Phase 0 front matter should be intentionally small:

- `tracker`
- `polling`
- `workspace`
- `hooks`
- `agent`

Minimum required values:

- tracker kind and readiness policy
- poll interval
- workspace root
- `after_create` setup hook
- agent command
- agent timeout

### 3. Bootstrap GitHub Tracker

Implement a temporary but real GitHub adapter for self-hosting.

Bootstrap dispatch policy:

- eligible issue: open issue with label `symphony:ready`
- claimed issue: label `symphony:running`
- failed issue: label `symphony:failed`
- success: issue is closed or otherwise updated according to the workflow policy

Required operations:

- fetch eligible issues
- claim issue atomically enough for a single orchestrator process
- refresh one issue
- mark failure
- close or update success state

Notes:

- This adapter should be isolated behind a `Tracker` interface so it can be replaced later.
- The maintained GitHub backend in Phase 7 will likely have different semantics; do not overfit Phase 0 here.

### 4. Workspace Manager

Phase 0 workspace behavior:

- derive deterministic workspace path from issue identifier
- create workspace directory
- run `after_create` hook only when the workspace is first created
- clone the target repo into the workspace
- reuse the same workspace if the issue is retried during a single run
- support cleanup for successful terminal runs

Workspace naming:

- use sanitized issue identifier or number
- avoid tempdir-only random paths so logs and debugging remain legible

### 5. Local Runner

Implement one real runner that can launch an agent command in a workspace.

Phase 0 runner requirements:

- launch command via `bash -lc`
- pass rendered prompt through stdin or a prompt file
- capture stdout, stderr, exit code, start time, and end time
- enforce timeout
- support termination from the orchestrator

Do not fake this with `echo`.

### 6. Orchestrator

Implement the minimum useful coordination loop:

- fixed poll cadence
- bounded concurrency
- in-memory claimed/running issue tracking
- dispatch only when capacity is available
- one retry policy with exponential backoff
- continue processing when one issue fails

Phase 0 behavior can be simple:

- single process
- in-memory runtime state only
- no dynamic workflow reload yet
- no advanced reconciliation beyond “refresh issue before/after run if needed”

### 7. Observability

Emit structured JSON logs to stdout.

Every run should log:

- poll tick start and finish
- candidate count
- claim attempt and result
- workspace path
- runner launch and completion
- retry scheduling
- final success or failure state

### 8. Testing

Required test layers:

1. Unit tests
   - workflow parser and renderer
   - config validation
   - workspace path derivation
   - runner timeout/error handling
   - tracker payload normalization

2. Service contract tests
   - tracker contract
   - workspace contract
   - runner contract

3. Integration harness
   - fake tracker + fake runner happy path
   - fake tracker + real workspace setup path
   - retry path
   - failure path

4. Manual acceptance test
   - real GitHub issue
   - real agent
   - real PR

## Proposed File Plan

Initial file targets:

```text
bin/symphony.ts
src/cli/index.ts
src/config/schema.ts
src/config/load.ts
src/observability/service.ts
src/orchestrator/service.ts
src/orchestrator/state.ts
src/runner/service.ts
src/runner/local.ts
src/tracker/service.ts
src/tracker/github-bootstrap.ts
src/workspace/service.ts
src/workspace/local.ts
```

This file map is a starting point, not a hard constraint. Keep file sizes small.

## Delivery Sequence

1. scaffold repo and CI
2. implement workflow/config loader
3. implement observability
4. implement workspace layer
5. implement local runner
6. implement bootstrap GitHub tracker
7. implement orchestrator loop
8. add integration harness
9. run manual ouroboros test

## Key Risks

### GitHub claim semantics

Issue labels are not a perfect lock. For Phase 0, this is acceptable if we assume one orchestrator instance. Do not design around multi-process GitHub locking yet.

### Agent invocation shape

Different agents want prompts through different channels. The Phase 0 runner should normalize this through one config shape and one local adapter.

### Workspace setup cost

Repeated full clones will slow iteration. Favor deterministic workspace reuse over disposable tempdirs.

## Open Questions To Resolve During Build

1. Should the Phase 0 agent prompt be passed as stdin, file path, or both?
2. Should successful runs auto-close issues, relabel them, or leave final mutation to the agent?
3. What is the minimum retry policy that helps more than it hurts in Phase 0?

## Exit Condition

Once the ouroboros loop works and the implementation is no longer fighting its own structure, move immediately to Phase 1 and clean up the service contracts before adding Beads.
