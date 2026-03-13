# Issue 138 Plan: TUI Live Runner Telemetry Parity

## Status

- plan-ready

## Goal

Make the detached factory TUI reflect live runner telemetry for active Codex runs so an issue with recent heartbeat/action/stdout activity no longer renders the misleading fallback `no codex message yet`.

## Scope

- identify why the TUI running row can fall back to `lastCodexMessage` emptiness even when the normalized runtime snapshot already has live `runnerVisibility` facts
- align the TUI running-row event and session display with the same authoritative live runner fields used by `factory status`
- preserve the existing graceful fallback for genuinely silent runs that have not emitted any runner activity yet
- add focused unit and regression coverage for the reproduced detached-factory shape
- run the local TUI QA dump plus repo-required checks for touched surfaces

## Non-goals

- changing runner behavior, Codex transport, or app-server event parsing
- redesigning the TUI layout or column model
- changing factory-control startup, detached-session packaging, or watchdog policy
- broad refactors across tracker, workspace, or retry/reconciliation logic
- adding durable historical event storage beyond the existing snapshot

## Current Gaps

- `factory status` renders `activeIssue.runnerVisibility.*` directly, including `lastActionSummary`, `lastHeartbeatAt`, and `stdoutSummary`
- the TUI `running` rows are still built from `runningEntries` fields such as `lastCodexEvent`, `lastCodexMessage`, and `sessionId`
- a live Codex run can therefore show real runner activity in the normalized status snapshot while the TUI row still reports `no codex message yet`
- the two operator surfaces disagree even though they are describing the same active issue

## Decision Notes

- The authoritative current-state source for live runner telemetry in this slice is the normalized `runnerVisibility` object already persisted in runtime status state.
- The TUI should prefer normalized visibility facts before falling back to raw `lastCodexMessage` payloads from the running-entry event stream.
- This issue remains an observability-surface correctness fix. If a tiny TUI snapshot-shape extension is needed, it should carry normalized observability data only and should not reopen runner or orchestrator behavior.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the operator-facing rule that live runner telemetry must be consistent across `factory status` and the TUI
  - does not belong: Codex protocol parsing details or detached-runtime control flow changes
- Configuration Layer
  - belongs: unchanged existing observability/dashboard config
  - does not belong: new workflow flags or TUI-specific configuration knobs
- Coordination Layer
  - belongs: only a minimal snapshot projection change if the TUI needs normalized active-issue visibility threaded into its row model
  - does not belong: retry policy, continuation semantics, leases, or handoff state redesign
- Execution Layer
  - belongs: unchanged existing runner visibility production from the Codex app-server path
  - does not belong: any new runner-side telemetry semantics in this slice
- Integration Layer
  - belongs: untouched; tracker adapters remain out of scope
  - does not belong: status/TUI presentation logic
- Observability Layer
  - belongs: TUI row formatting, event/session fallback rules, snapshot consumption, and regression tests
  - does not belong: direct child-process inspection or tracker-specific lifecycle inference at render time

## Architecture Boundaries

### Belongs in this issue

- `src/orchestrator/service.ts`
  - only if needed to expose normalized active-issue runner visibility to the TUI snapshot model
- `src/observability/tui.ts`
  - teach running rows to derive session/event text from normalized runner visibility first, then raw Codex message fields, then the silent fallback
- `tests/unit/tui.test.ts`
  - lock in row formatting for silent runs, live runner heartbeat/action shapes, and Codex stdout-preview activity
- `tests/fixtures/tui-qa-dump.ts` or existing TUI QA path
  - exercise the touched rendering path if a fixture update is needed

### Does not belong in this issue

- `src/runner/`
  - no change to Codex transport or event normalization unless a minimal bug fix is required to preserve existing visibility fields
- `src/tracker/`
  - no tracker transport, normalization, or policy changes
- `src/workspace/`
  - no workspace lifecycle changes
- detached factory control commands or status CLI redesign

## Layering Notes

- `config/workflow`
  - continues to define dashboard refresh behavior only
  - does not gain observability-parity toggles
- `tracker`
  - remains the source of issue/PR lifecycle facts
  - does not influence TUI runner event selection
- `workspace`
  - remains unrelated to status rendering
- `runner`
  - continues to publish normalized visibility updates
  - does not render human-readable dashboard labels
- `orchestrator`
  - may project existing normalized visibility into `TuiSnapshot`
  - should not duplicate TUI-specific humanization logic in status state
- `observability`
  - owns the row-level preference order and human-readable fallback text
  - should not infer liveness by reading runner internals outside the snapshot contract

## Slice Strategy And PR Seam

One reviewable PR with one seam:

1. expose the already-normalized live runner visibility the TUI needs
2. update TUI row rendering to prefer that visibility for session/event details
3. add regression coverage for the detached factory shape where live Codex activity exists without a populated `lastCodexMessage`

This stays narrow because it does not combine:

- runner transport changes
- control-plane launch fixes
- broader TUI redesign
- tracker or handoff policy work

## Runtime State Model

This issue does not change orchestration state transitions, retry policy, continuation logic, reconciliation, leases, or handoff states.

Existing runner visibility states (`starting`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `timed-out`) remain the source of truth. The work in this issue is limited to how observability consumes that already-normalized state.

## Failure-Class Matrix

| Observed condition | Runtime facts available | TUI expectation |
| --- | --- | --- |
| Active run has no Codex event payloads and no `runnerVisibility.lastActionSummary`/`stdoutSummary` yet | running row exists, visibility is absent or silent | render `no codex message yet` |
| Active run has `runnerVisibility.lastActionSummary` and recent heartbeat but no raw `lastCodexMessage` | normalized visibility proves live activity | render the visibility-derived event text, not the silent fallback |
| Active run has `runnerVisibility.stdoutSummary` with Codex stdout preview such as `thread/started` | normalized visibility shows runner output preview | render the stdout/action-derived label and keep session details populated when available |
| Active run has both raw Codex message payload and normalized visibility | both sources are present | prefer the normalized visibility fields when they carry newer or stronger live-state detail; preserve raw-message humanization as fallback |

## Observability Requirements

- TUI and `factory status` must agree on whether a live run has runner activity
- the running row should show the best available current session/event detail from the normalized snapshot
- fallback text should remain explicit and only appear for truly silent runs
- tests should prove parity for the reproduced `#137` shape where `factory status` had live runner heartbeat/action/stdout output

## Implementation Steps

1. Inspect the current `TuiSnapshot.running` contract and identify the smallest way to thread `runnerVisibility`-derived session/event data into each row.
2. Extend the TUI row model only as needed, preferably by projecting normalized visibility into the snapshot builder rather than re-reading status state inside observability.
3. Add a helper in `tui.ts` that chooses row session/event text in this order:
   - normalized `runnerVisibility` fields
   - existing raw `lastCodexMessage` plus `lastCodexEvent`
   - silent fallback text
4. Keep existing event humanization for raw Codex payloads, but add a small normalized-visibility formatter for live action/stdout cases.
5. Update or add tests to cover silent, heartbeat-only, and stdout-preview cases.
6. Run TUI QA and the repo-required checks.

## Tests And Acceptance Scenarios

### Unit tests

- `tests/unit/tui.test.ts`
  - active run with no raw message and no visibility detail still renders `no codex message yet`
  - active run with `runnerVisibility.lastActionSummary` and `lastHeartbeatAt` does not render the silent fallback
  - active run with `runnerVisibility.stdoutSummary` containing Codex app-server output does not render the silent fallback
  - active run with both visibility data and raw `lastCodexMessage` renders the intended preference order

### Visual QA

- `npx tsx tests/fixtures/tui-qa-dump.ts`
  - inspect the running row at common widths and verify the event column shows live runner telemetry text rather than the silent fallback for the regression fixture

### Repository checks

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

## Acceptance Scenarios

1. A detached factory run has an active Codex session with recent heartbeat/action timestamps and stdout preview in `runnerVisibility`, but `lastCodexMessage` is still empty.
   - Expected: the TUI row shows live session/event detail and does not show `no codex message yet`.
2. A newly started run has not produced any raw message or normalized runner action yet.
   - Expected: the TUI still shows `no codex message yet`.
3. `factory status` and the TUI inspect the same active issue with live Codex activity.
   - Expected: both surfaces agree that the runner is active and has emitted recent activity.

## Exit Criteria

- the TUI running row no longer shows `no codex message yet` when normalized live runner activity is present
- the TUI and `factory status` agree on active runner telemetry for the reproduced detached-run shape
- regression coverage exists for silent and live-activity cases
- local QA and required checks pass

## Deferred To Later Issues Or PRs

- any redesign of the TUI layout or event taxonomy
- changes to how runner visibility is produced in `src/runner/`
- historical event timelines, richer transcript storage, or dashboard drill-down views
- detached factory control-plane fixes unrelated to observability parity
