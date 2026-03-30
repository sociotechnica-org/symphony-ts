# Plan for #275: Repair merged WORKFLOW.md observability parse regression blocking factory startup

## Scope

Restore self-hosted factory startup on `main` by making workflow parsing tolerate a comment-only top-level `observability:` block, then cover the regression with a focused parser test.

## Plan Review Status

Plan review is explicitly waived by direct human instruction in the active terminal session to fix and land this outage immediately.

## Layer Mapping

- Policy: preserve existing workflow semantics where omitted optional sections resolve through defaults.
- Configuration: adjust workflow parsing so top-level `observability: null` is treated like an omitted optional section.
- Coordination: none beyond restoring factory start/restart behavior.
- Execution: validate with direct startup smoke for the self-hosted workflow.
- Integration: none; this is local config parsing.
- Observability: add a unit regression so the startup failure mode stays covered.

## Non-Goals

- no broader redesign of `WORKFLOW.md`
- no changes to tracker semantics or runtime identity handling
- no changes to user local workflow content beyond preserving current behavior

## Current Gap

Merged `main` rejects the checked-in `WORKFLOW.md` because a bare `observability:` stanza parses as YAML `null`, while `coerceOptionalObject` currently throws on explicit `null` for all top-level optional sections.

## Architecture Boundary

- Touch only config parsing and tests.
- Do not alter operator logic, tracker policy, or factory control paths.

## Implementation Steps

1. Update config resolution so `raw.observability === null` resolves to `{}` before optional observability parsing.
2. Add a focused unit test covering a comment-only top-level `observability:` block.
3. Validate with workflow unit tests and a real self-hosted startup smoke.
4. Open a PR, watch CI, address review, and merge.

## Tests

- `pnpm exec vitest run tests/unit/workflow.test.ts`
- `SYMPHONY_REPO=sociotechnica-org/symphony-ts pnpm tsx bin/symphony.ts run --workflow WORKFLOW.md --once --i-understand-that-this-will-be-running-without-the-usual-guardrails`
- repo pre-push gate via push / CI (`typecheck`, `lint`, `format:check`, `test`)

## Acceptance Scenarios

- Self-hosted `WORKFLOW.md` with a comment-only top-level `observability:` block loads successfully.
- Detached `factory start` can succeed again on repaired code.
- No regression to explicit observability config parsing.

## Exit Criteria

- parser fix and regression test merged to `main`
- self-hosted factory restarted successfully from merged `main`

## Deferred

- any broader cleanup of optional-null parsing consistency across other top-level sections
