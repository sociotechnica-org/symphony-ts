# Issue 314 Plan

- Status: waived
- Issue: #314
- Branch: `symphony/314`
- Plan path: `docs/plans/314-operator-terminal-trace/plan.md`

## Scope

Add a small foreground terminal trace to the operator loop so operators can see when a wake-up begins, whether it is resuming a stored session, and when the loop returns to sleep.

## Non-goals

- Redesign operator status artifacts, wake-up logs, or instance state layout.
- Change operator queue logic, prompt content, or release-state semantics.
- Change resumable-session behavior beyond surfacing the current mode and backend session id.

## Layer Mapping

- Observability: emit a concise terminal-facing trace with timestamps for human operators.
- Coordination: keep the loop/sleep lifecycle unchanged while surfacing state transitions.
- Execution: preserve the existing operator command and resumable-session preparation path.
- Not in scope: tracker integration, workflow parsing, factory orchestration, or runner transport changes.

## Current Gaps

- Foreground `pnpm operator` runs do not show when a cycle wakes up.
- Operators cannot tell from the terminal whether a cycle is starting fresh or resuming a stored session.
- The loop returning to sleep is only visible through instance status artifacts, not the foreground terminal.

## Implementation Steps

1. Add small timestamped terminal-trace helpers in `skills/symphony-operator/operator-loop.sh`.
2. Emit a wake-up line before each cycle starts, including fresh vs resuming mode and the backend session id when present.
3. Emit a sleep line after successful and retry cycles in continuous mode, including the next wake time.
4. Cover the trace in `tests/integration/operator-loop.test.ts` without changing the canonical status-file assertions.

## Tests

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- focused integration assertions in `tests/integration/operator-loop.test.ts`

## Acceptance

- Foreground operator runs print a timestamped wake-up line for each cycle.
- The wake-up line includes whether the cycle is fresh or resuming, plus the backend session id when one exists.
- Continuous runs print a timestamped sleep line before waiting for the next cycle.
- Existing machine-readable operator status artifacts remain unchanged in meaning.
