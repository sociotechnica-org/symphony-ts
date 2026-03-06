# Phase 6.1 Technical Plan: Supervised Run Ownership and Orphan Reconciliation

## Goal

Make the local factory own active issue runs and agent subprocesses explicitly enough that a `symphony:running` issue can be recovered automatically after poll-loop loss, worker loss, agent loss, or process restart.

For issue `#19`, "ownership" means:

- the runtime records which factory process owns each in-flight issue
- the runtime records which agent subprocess belongs to that issue run
- shutdown and restart paths reconcile tracker state against local runtime state
- orphaned `symphony:running` issues are retried or failed by Symphony itself rather than waiting for a human cleanup loop

## Scope

Required outcomes for issue `#19`:

1. add durable runtime state for active run ownership and subprocess metadata
2. let the orchestrator observe runner child-process ownership directly
3. reconcile `symphony:running` issues against local ownership state on startup and during polls
4. detect dead worker / dead agent cases and convert them into explicit retry or fail transitions
5. cover restart recovery and orphaned-run repair in unit and e2e tests

## Current Gaps

Today the runtime still has important ownership blind spots:

- active runs only exist in memory as `runningIssueNumbers`
- the local issue lease tracks only the factory PID, not the agent subprocess PID
- a dead factory process can leave a live agent subprocess behind with no supervisor
- a dead factory process can also leave a `symphony:running` issue behind until a human notices
- startup does not inspect prior local run state before resuming tracker polling
- graceful shutdown does not propagate cancellation into the runner boundary

## Design Direction

### 1. Introduce a durable run-ownership record

Add a focused orchestration module that persists one active-run record per issue under the local runtime root.

Each record should include:

- issue number / identifier
- branch name
- run session id
- run attempt sequence
- factory owner PID
- runner child PID when available
- timestamps for acquisition / runner launch / last update

This state should stay local and runtime-oriented. It is not tracker policy.

### 2. Promote subprocess ownership into the runner contract

The orchestrator should not treat `runner.run()` as an opaque promise.

Update the runner interface so local runner implementations can report:

- when the agent subprocess has actually spawned
- the child PID the runtime owns
- shutdown-triggered cancellation distinctly from normal run failure

That lets the orchestrator persist live child ownership and terminate owned subprocesses during shutdown or orphan cleanup.

### 3. Reconcile running issues from runtime supervision

Before normal dispatch, the orchestrator should reconcile tracker `running` issues against local run ownership:

- if tracker says an issue is running and the local ownership record is healthy, leave it alone
- if the ownership record says the owner is dead or the child process is missing, treat the run as orphaned
- if an orphaned agent subprocess is still alive but its owner is dead, terminate it before requeueing work
- if a running issue has no healthy ownership and no merge-ready PR lifecycle, retry or fail it through the existing tracker transitions

This keeps recovery in the factory rather than in an operator shell wrapper.

### 4. Make startup recovery explicit and idempotent

Startup should inspect both:

- tracker state (`symphony:running` issues)
- local runtime state (active-run ownership files / locks)

The recovery pass must be safe to run more than once and should clear stale local ownership entries once they have been reconciled.

### 5. Keep leases and supervision focused

The existing local issue lease should evolve into a small coordination layer, but supervision logic should remain explicit in its own module instead of spreading across the orchestrator.

The orchestrator should consume named operations such as:

- acquire active run ownership
- attach runner PID
- inspect runtime ownership health
- terminate orphaned subprocess
- release ownership after completion / failure / recovery

## Implementation Plan

### 1. Domain and service contracts

Add normalized runtime types for:

- active run ownership snapshot
- ownership health / reconciliation result
- runner spawn / cancellation callbacks

Update the runner contract so the orchestrator can observe child spawn and forward cancellation.

### 2. Runtime supervision module

Add a focused orchestration module that:

- persists active run metadata under the workspace root
- reuses local PID probing for owner / child liveness
- distinguishes healthy, orphaned, and stale ownership states
- can terminate an orphaned child process and clean up its record

### 3. Orchestrator recovery flow

Refactor the orchestrator so it:

- performs a startup/poll recovery pass before normal dispatch
- keeps explicit in-memory state for active sessions in addition to durable ownership
- updates ownership state when a runner child spawns
- cancels active child processes on shutdown
- schedules retries or terminal failure from supervised recovery instead of silent abandonment

### 4. Local runner changes

Update `src/runner/local.ts` so it:

- reports the spawned child PID to the orchestrator
- supports cancellation via `AbortSignal`
- returns a typed cancellation/termination failure when shutdown interrupts a run

### 5. Test harness and e2e coverage

Add coverage for:

- dead agent subprocess while the factory is still alive
- dead factory owner with a stale active-run record
- dead factory owner with a still-live orphaned agent subprocess
- startup recovery that repairs a `symphony:running` issue and resumes work
- graceful shutdown that cancels owned subprocesses and leaves recoverable tracker state

## Risks

### PID-based liveness is local-only

This feature is intentionally local-process supervision for Phase 6.1. The runtime state and recovery policy should stay explicit so a future remote runner can swap the mechanism without changing orchestrator policy.

### Retry loops after bad recovery

Recovery must not create an infinite rerun loop for a permanently broken issue. Reuse the existing retry budget and failure transitions instead of inventing a second retry system.

### Cleanup races

Ownership cleanup needs to tolerate races between normal completion, shutdown, and restart recovery. File updates should therefore be idempotent and narrowly scoped.

## Exit Criteria

This issue is complete when:

1. active issue runs have durable local ownership state
2. the orchestrator can identify whether a running issue still has a live owned subprocess
3. orphaned `symphony:running` issues are retried or failed automatically during recovery
4. restart recovery is explicit and tested
5. the e2e harness covers the observed orphaned-run failure mode
