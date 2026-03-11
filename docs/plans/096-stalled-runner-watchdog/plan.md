# Plan: Stalled Runner Watchdog and Auto-Recovery

**Issue:** #96
**Status:** plan-ready (operator-directed implementation)
**Spec layers:** Coordination (watchdog scheduling), Execution (runner termination), Observability (stall classification and events)

## Scope

Add stall detection and bounded auto-recovery to the factory orchestrator.

## Non-goals

- Runner architecture redesign
- Merge automation policy
- Replacing operator controls

## Design

### Stall Signals

1. **Log growth** — runner session log size unchanged within threshold
2. **Workspace diff** — no git changes within threshold
3. **PR head movement** — PR SHA unchanged while feedback remains

### Stall Classification

`StallReason: "log-stall" | "workspace-stall" | "pr-stall"`

### Config

`WatchdogConfig { enabled, checkIntervalMs, stallThresholdMs, maxRecoveryAttempts }`

### Recovery

1. Detect stall → classify → abort runner → requeue via retry → emit event
2. Track recovery count per issue to bound retries

### Files

- `src/orchestrator/stall-detector.ts` — pure detection
- `src/orchestrator/state.ts` — watchdog state
- `src/orchestrator/service.ts` — integration
- `tests/unit/stall-detector.test.ts`
- Updated orchestrator tests

## Acceptance

- Auto-recovery from simulated stuck runner
- Stall classification in status
- Bounded recovery (no infinite loops)
