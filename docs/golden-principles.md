# Golden Principles

Rules for building `symphony-ts`.

## 1. Spec-Shaped Core

The Symphony spec is the primary design reference.

If local code and the spec diverge, treat that as a design decision that must be made explicit.

## 2. Parse at the Boundary

External data must be parsed and normalized at ingress:

- `WORKFLOW.md`
- environment/config
- tracker payloads
- runner output
- hook output

Internal code should operate on typed values, not ad hoc raw payloads.

## 3. Service Boundaries First

All major side effects should live behind explicit service contracts:

- tracker
- workspace
- runner
- observability
- workflow/config loader

Avoid leaking backend-specific behavior into the orchestrator.

## 4. Real End-to-End Behavior Beats Fake Progress

Do not simulate core behavior once a real path is feasible.

Examples:

- do not fake runner execution with `echo`
- do not pretend a workspace exists without cloning or preparing it
- do not claim the system works end-to-end without a real issue and a real agent run

## 5. Keep the Core Boring

The project should be easy for agents to inspect and extend.

Prefer:

- obvious names
- narrow files
- explicit state transitions
- simple data flow

Avoid clever abstractions that reduce legibility.

## 6. Structured Logs, Not Narrative Logs

Runtime logs should be machine-parseable and operator-useful.

Every important transition should carry context such as:

- issue id / identifier
- workspace path
- runner/session id
- retry attempt
- timing

## 7. Separate Policy From Mechanism

Examples:

- tracker label/state conventions are policy
- polling, retries, and concurrency are mechanism
- prompt wording is policy
- runner launch/stop/status is mechanism

Keep policy configurable and keep mechanisms reusable.

## 8. Deterministic Workspaces

Workspace paths should be predictable and stable enough for debugging, retries, and cleanup.

Avoid disposable randomness unless isolation requires it.

## 9. Fail Loudly at Boundaries

Missing workflow files, invalid templates, invalid tracker responses, and broken hooks should produce typed failures with enough context to diagnose the cause quickly.

Silent fallback behavior should be rare and deliberate.

## 10. Test the Contracts

Tests should verify behavior, not just existence.

At minimum:

- unit tests for parsers and normalization
- contract tests for each service
- orchestrator state-transition tests
- at least one integration harness per major phase

## 11. Bootstrap Fast, Refactor Early

Phase 0 is allowed to be minimal.

Phase 1 is where we pay down structure before adding major new capabilities. Do not pile Beads and remote execution on top of a shaky bootstrap implementation.

## 12. Beads Is Primary, But Not the Core Model

Beads should shape the long-term product direction, but the orchestrator core should stay general enough that tracker-specific semantics remain mostly in adapters and workflow policy.
