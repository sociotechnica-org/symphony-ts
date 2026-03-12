# Issue 114 Plan: Validate Explicit Runner Kind Against Command During Workflow Parsing

## Status

- plan-ready

## Goal

Fail invalid explicit runner selections at workflow-load time by cross-validating `agent.runner.kind` against `agent.command` in `src/config/workflow.ts`, so incompatible configurations raise `ConfigError` before runner construction.

## Scope

- update workflow parsing to validate explicit `agent.runner.kind` selections against the parsed runner command
- keep implicit runner inference unchanged when `agent.runner` is omitted
- reject known explicit mismatches in the configuration layer with field-specific `ConfigError`s
- add focused unit coverage for valid and invalid explicit runner-kind / command combinations

## Non-goals

- changing orchestrator behavior, retry policy, or runtime state
- redesigning the runner factory or `Runner` contract
- expanding provider capability modeling beyond command invariants already known in config and runner helpers
- adding fallback or automatic conversion between runner kinds
- moving Claude-specific execution validation out of the runner layer unless it is needed only to fail obvious config mismatches earlier

## Current Gaps

- `resolveAgentRunnerConfig()` accepts any supported explicit `agent.runner.kind` without checking whether `agent.command` invokes the corresponding CLI
- `inferAgentRunnerConfig()` already inspects the parsed executable, so omitted `agent.runner` and explicit `agent.runner` follow different validation paths today
- `CodexRunner` and `ClaudeCodeRunner` still catch incompatible commands later in the execution layer with `RunnerError`, which makes workflow validation timing inconsistent
- current workflow unit tests cover valid runner parsing but do not lock the expected config-layer failure for explicit mismatches

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the repo-owned rule that explicit runner selection in `WORKFLOW.md` must match the declared command contract
  - does not belong: subprocess launch details or continuation-session mechanics
- Configuration Layer
  - belongs: parsing `agent.command`, validating explicit `agent.runner.kind`, and raising `ConfigError` before runtime wiring proceeds
  - does not belong: spawning the process, discovering backend sessions, or tracker mutations
- Coordination Layer
  - belongs: untouched in this slice
  - does not belong: compensating for invalid workflow config after startup
- Execution Layer
  - belongs: existing runner-specific command validation that remains necessary for deeper backend invariants
  - does not belong: being the first place that catches obvious explicit runner-kind / command mismatches already knowable during workflow parsing
- Integration Layer
  - belongs: untouched in this slice
  - does not belong: workflow runner-kind validation
- Observability Layer
  - belongs: tests asserting precise config failure messages
  - does not belong: inferring backend compatibility from runtime logs

## Architecture Boundaries

### Belongs in this issue

- `src/config/workflow.ts`
  - cross-check explicit runner kind against the parsed executable / known command invariants
  - keep inference for omitted `agent.runner` unchanged
- targeted runner-command helper reuse only if needed to avoid duplicating trivial executable checks
- `tests/unit/workflow.test.ts`
  - add explicit mismatch coverage and valid explicit-config coverage

### Does not belong in this issue

- changes to `src/orchestrator/`
- runner-factory selection changes in `src/runner/factory.ts`
- workspace or tracker changes
- broader Claude capability or continuation redesign
- status/reporting changes

## Layering Notes

- `config/workflow`
  - owns early validation of repo-owned workflow contracts
  - should only validate facts already available from front matter and command parsing
- `runner`
  - continues to own backend-specific runtime validation and execution semantics
  - should not be the sole enforcement point for explicit config mismatches knowable at load time
- `orchestrator`
  - remains unaware of this validation rule
  - should keep receiving already-validated config

## Slice Strategy And PR Seam

This should stay one small reviewable PR because it only tightens the configuration boundary:

1. add explicit runner-kind / command compatibility checks in workflow parsing
2. add focused unit tests for mismatches and preserved valid cases
3. leave runner, orchestrator, tracker, and workspace behavior unchanged

The seam is reviewable on its own because it does not mix config cleanup with runner-factory redesign or broader provider modeling.

## Runtime State Model

Not applicable. This issue does not change retries, continuations, reconciliation, leases, or handoff states; it only moves one class of failure earlier to workflow parsing.

## Validation Failure Matrix

| Observed input                                                              | Boundary facts available              | Expected decision                                                      |
| --------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `agent.runner.kind` omitted and `agent.command` starts with `codex`         | raw command string, parsed executable | preserve existing inference and resolve `runner.kind: codex`           |
| `agent.runner.kind` omitted and `agent.command` does not start with `codex` | raw command string, parsed executable | preserve existing inference and resolve `runner.kind: generic-command` |
| `agent.runner.kind: codex` and command executable is not `codex`            | explicit kind, parsed executable      | fail `loadWorkflow()` with `ConfigError` naming the explicit mismatch  |
| `agent.runner.kind: claude-code` and command executable is not `claude`     | explicit kind, parsed executable      | fail `loadWorkflow()` with `ConfigError` naming the explicit mismatch  |
| `agent.runner.kind: generic-command` with a `codex` or `claude` command     | explicit kind, parsed executable      | load successfully; generic command is the permissive fallback path     |
| explicit supported runner kind with a compatible command                    | explicit kind, parsed executable      | load successfully and preserve the explicit kind                       |

## Observability Requirements

- config failures should remain loud and field-specific
- tests should assert `ConfigError` rather than a later `RunnerError`
- no new structured logs or status fields are required

## Implementation Steps

1. Refactor `resolveAgentRunnerConfig()` so explicit runner selection can inspect `agent.command` during parsing.
2. Add a small config-layer compatibility check for explicit runner kinds:
   - `codex` requires a parsed executable basename of `codex`
   - `claude-code` requires a parsed executable basename of `claude`
   - `generic-command` remains permissive
3. Keep `inferAgentRunnerConfig()` unchanged for omitted `agent.runner`.
4. Add workflow unit tests for:
   - explicit `codex` + non-Codex command => `ConfigError`
   - explicit `claude-code` + non-Claude command => `ConfigError`
   - explicit `generic-command` + Codex/Claude command still loading cleanly
   - explicit valid `codex` and `claude-code` configs still loading cleanly
5. Run the repo gate for typecheck, lint, and tests.

## Tests And Acceptance Scenarios

### Unit

- `loadWorkflow()` rejects `agent.runner.kind: codex` when `agent.command` does not invoke `codex`
- `loadWorkflow()` rejects `agent.runner.kind: claude-code` when `agent.command` does not invoke `claude`
- `loadWorkflow()` still accepts explicit `generic-command` for arbitrary commands, including commands that happen to invoke `codex` or `claude`
- `loadWorkflow()` still accepts valid explicit `codex` and `claude-code` configurations

### Integration

- no new integration harness is required because the observable behavior change is entirely at the configuration boundary and is covered by `loadWorkflow()` tests

### Acceptance Scenarios

1. A workflow with `agent.runner.kind: codex` and `agent.command: claude --print` fails during `loadWorkflow()` with `ConfigError`.
2. A workflow with `agent.runner.kind: claude-code` and `agent.command: codex exec -` fails during `loadWorkflow()` with `ConfigError`.
3. A workflow with `agent.runner.kind: generic-command` still parses cleanly for commands that are not tied to a first-class backend contract.
4. Existing valid explicit runner selections continue to parse cleanly.

## Exit Criteria

- explicit runner-kind / command mismatches fail during workflow parsing
- implicit inference behavior remains unchanged when `agent.runner` is omitted
- targeted unit tests lock the mismatch behavior and preserved valid cases
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass after the change

## Deferred To Later Issues Or PRs

- moving all Claude command-shape invariants into config parsing
- broader provider capability metadata in workflow config
- runner-factory or orchestrator changes
- any fallback or dynamic runner selection behavior

## Decision Notes

- Keep the config-layer check intentionally narrow: validate only command compatibility facts already available from parsing the executable, and leave deeper backend-specific constraints in the runner layer.
- Treat `generic-command` as the permissive explicit escape hatch so this issue does not accidentally turn explicit runner selection into capability modeling.
