# Failure Drills

These drills rehearse the supported Phase 6 recovery behavior using the existing runtime contract. They are for operator practice and validation, not for inventing new recovery paths.

Use [`operator-runbook.md`](./operator-runbook.md) as the daily-use companion.

## Ground Rules

- Start from the checked-in control path: `factory status`, `factory watch`, `factory attach`, `factory start`, `factory restart`, `factory pause`, `factory resume`, `factory stop`.
- Treat `factory status --json` as the primary evidence source.
- Use retained workspaces and `.var/factory/issues/` artifacts to confirm what happened.
- Do not normalize raw `screen` attachment or ad hoc process cleanup into the procedure unless the supported control path is broken.

## Drill 1: Detached Runtime Stopped Unexpectedly

Goal: confirm that operators can detect and recover a stopped detached runtime cleanly.

1. Stop the detached runtime or simulate a crash in a controlled local environment.
2. Run `pnpm tsx bin/symphony.ts factory status --json`.
3. Confirm the control surface reports `stopped` or `degraded` rather than pretending the factory is healthy.
4. Run `pnpm tsx bin/symphony.ts factory start` or `pnpm tsx bin/symphony.ts factory restart`.
5. Re-check `factory status --json` and confirm the embedded runtime snapshot becomes current again.

Expected evidence:

- control state changes from stopped/degraded back to running
- startup publishes a fresh status snapshot
- if inherited `symphony:running` work exists, restart reconciliation becomes visible instead of silently resuming

## Drill 2: Restart With Inherited `symphony:running` Work

Goal: verify restart reconciliation is visible and operators know not to duplicate work manually.

1. Start from a local state where an issue is still labeled `symphony:running`.
2. Restart the factory.
3. Inspect `factory status --json`.
4. Review `status.restartRecovery` and `status.recoveryPosture`.
5. Confirm the per-issue decision before taking any manual action.

Expected evidence:

- `restart-recovery` posture appears during or after startup
- the per-issue decision explains whether the run was adopted, suppressed, requeued, or degraded
- no duplicate rerun starts when tracker handoff already shows review or landing state

## Drill 3: Watchdog-Aborted Or Stalled Runner

Goal: verify operators can recognize watchdog recovery without flattening it into a generic crash story.

1. Use a controlled local test or fixture that stalls a worker long enough to trigger watchdog handling.
2. Inspect `factory status --json` and `factory watch`.
3. Confirm the relevant issue shows watchdog recovery or watchdog-driven retry posture.
4. Inspect the issue artifact directory and retained workspace if the run exhausted recovery.

Expected evidence:

- `watchdog-recovery` appears in `status.recoveryPosture`
- the last action or retry entry preserves the watchdog reason
- retained local artifacts make the failure inspectable if the run ends terminally

## Drill 4: Retry / Backoff Under Provider Pressure

Goal: verify that operators can distinguish intentional backoff from a broken runtime.

1. Trigger a structured transient failure such as provider rate-limit pressure in the mocked harness or a controlled local repro.
2. Inspect `factory status --json` immediately after the failed turn.
3. Confirm the issue is queued in `status.retries` with the correct retry class.
4. Wait for the retry window to expire and confirm the issue re-enters dispatch normally.

Expected evidence:

- `retry-backoff` posture is visible while the issue is queued
- dispatch pressure, if active, explains why new work is paused
- the issue retries without losing its coordination state

## Drill 5: Retained Failure Workspace Inspection

Goal: verify that operators can inspect post-failure evidence without relying on shell folklore.

1. Start from a terminal failure that retains its workspace.
2. Read the issue artifact summary under `.var/factory/issues/<issue-number>/`.
3. Inspect the retained workspace under `.tmp/workspaces/<issue-number>/`.
4. Confirm whether retention happened because of failure, cleanup policy, or cleanup failure.
5. After diagnosis, either clean up locally or relabel/rerun through the normal tracker workflow once the root cause is fixed.

Expected evidence:

- the artifact summary and status surfaces agree about the terminal outcome
- the retained workspace is still inspectable
- cleanup failures remain visible as degraded posture rather than disappearing

## Drill 6: Intentional Stop-The-Line Halt

Goal: verify that operators can halt new dispatch with a durable reason, stop
the detached runtime if needed, and later require an explicit resume.

1. Start from a controlled repo state with at least one ready issue.
2. Run `pnpm tsx bin/symphony.ts factory pause --reason "Prerequisite ticket failed; stop the line until release reconciliation finishes."`
3. Inspect `factory status --json` and `factory watch`.
4. Confirm `status.factoryHalt.state` is `halted`, the reason is present, and no fresh ready issue dispatches.
5. Optionally run `pnpm tsx bin/symphony.ts factory stop`, then `factory start`.
6. Confirm the instance still reports `halted` after restart.
7. Run `pnpm tsx bin/symphony.ts factory resume` and confirm dispatch can proceed again.

Expected evidence:

- `status.factoryHalt` carries the halt reason and timestamp
- ready queue facts remain visible, but no new dispatch starts while halted
- stopping and restarting the detached runtime does not clear the halt
- `factory resume` clears the halt and returns the instance to normal dispatch posture

## Stability Drill: Concurrent Legibility

Goal: verify that mixed issue states stay operator-legible under configured concurrency.

Run:

```bash
pnpm test -- tests/e2e/bootstrap-factory.test.ts
```

Focus on the concurrency validation that runs two issues with `max_concurrent_runs > 1`:

- one issue reaches PR handoff and remains in `waiting-expected`
- one issue enters provider-pressure retry backoff

Expected evidence:

- the status snapshot keeps both issues visible
- the retrying issue appears in `status.recoveryPosture.entries` as `retry-backoff`
- the waiting issue still appears in the posture entries instead of disappearing behind the retrying issue

## When To Stop And Escalate

Stop the drill and treat it as a product/runtime bug when:

- the supported control path cannot explain the runtime state
- `factory watch` and `factory status --json` disagree materially
- the runtime silently duplicates work after restart
- retries or watchdog recovery happen without corresponding status evidence
- retained artifacts needed for diagnosis are missing or contradictory

When that happens, keep the local state inspectable and open a focused follow-up issue instead of writing a new operator-only workaround.
