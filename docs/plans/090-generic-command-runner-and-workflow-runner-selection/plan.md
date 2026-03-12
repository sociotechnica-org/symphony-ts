# Issue 90 Plan: Generic Command Runner And Workflow Runner Selection

## Status

- plan-ready

## Goal

Add a workflow-owned runner selection seam so `WORKFLOW.md` can choose between the existing Codex-backed local path and a generic command-backed runner path, while keeping backend branching out of orchestrator logic.

## Scope

- extend typed workflow config with an explicit runner/backend selection model under `agent`
- add a generic command-backed runner implementation that satisfies the existing provider-neutral runner contract from `#89`
- keep Codex working as one selectable local backend
- add runner factory wiring so the CLI/runtime selects the configured runner without orchestrator branching
- add tests for workflow parsing, runner factory selection, and backend-specific execution/session behavior
- update repo docs and workflow examples so the new execution-layer seam is inspectable

## Non-goals

- Claude Code-specific prompt shaping, result normalization, or session reuse semantics from `#91`
- remote/background runner providers, leases, reconciliation, or new orchestration recovery behavior
- tracker transport, normalization, or policy changes
- multi-provider routing policy, fallback order, or dynamic per-issue backend choice
- changing workspace preparation, prompt rendering, or tracker handoff policy

## Current Gaps

- `src/domain/workflow.ts` exposes only `agent.command`, `promptTransport`, timeout, env, and turn limits; it has no typed runner/backend selection seam
- `src/cli/index.ts` always instantiates `LocalRunner`, so runtime wiring hard-codes one execution backend regardless of workflow config
- `src/runner/local.ts` currently serves two roles:
  - Codex-aware continuation/session behavior
  - generic subprocess launching for unknown commands
- tests prove the local runner can execute arbitrary commands, but they do not prove that workflow config can deliberately select Codex versus a generic backend path
- README and checked-in workflow examples still describe execution entirely in terms of `agent.command`

## Decision Notes

- Reuse the provider-neutral runner contract from `#89` rather than extending orchestrator interfaces again.
- Split the existing local path into two explicit execution-layer implementations:
  - a Codex runner that keeps Codex continuation/session discovery behavior
  - a generic command runner that launches arbitrary local CLIs without Codex-specific assumptions
- Keep backend selection in workflow/config plus execution wiring. The orchestrator should continue to receive a `Runner` instance and remain unaware of which backend was chosen.
- Keep prompt transport and env on the agent config because they apply to subprocess execution generally, not only to Codex.
- Prefer a narrow, repo-owned config seam such as `agent.runner.kind` with backend-specific nested config where needed, instead of encoding selection in free-form command heuristics alone.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the repo-owned decision that `WORKFLOW.md` selects the runner/backend and that this slice only supports explicit local backends
  - does not belong: subprocess launch details, continuation implementation, or tracker handoff policy
- Configuration Layer
  - belongs: parsing and validating runner selection from `WORKFLOW.md`, resolving typed runner config, and preserving the prompt template contract
  - does not belong: subprocess spawning, backend session discovery, or tracker mutations
- Coordination Layer
  - belongs: unchanged consumption of the provider-neutral `Runner` interface
  - does not belong: backend-specific `if` branches, command parsing, or provider selection logic
- Execution Layer
  - belongs: runner implementations, runner factory wiring, command execution behavior, and Codex-versus-generic backend details behind the runner contract
  - does not belong: prompt rendering, workspace lifecycle policy, tracker updates, or issue handoff logic
- Integration Layer
  - belongs: untouched in this slice
  - does not belong: runner/backend selection or subprocess execution
- Observability Layer
  - belongs: preserving normalized provider/model/session metadata for status and reports
  - does not belong: inferring backend behavior from raw command output

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - define typed runner/backend config variants under `agent`
- `src/config/workflow.ts`
  - parse, validate, and resolve the new workflow-owned runner selection seam
- `src/runner/`
  - extract a generic command runner
  - narrow the Codex-specific runner path behind its own implementation boundary
  - add a small runner factory for runtime wiring
- `src/cli/index.ts`
  - replace direct `LocalRunner` construction with runner-factory selection based on resolved workflow config
- tests
  - workflow parsing tests
  - runner factory/contract tests
  - focused execution tests for Codex and generic command runner behavior
- docs
  - README / `WORKFLOW.md` updates describing the new config seam

### Does not belong in this issue

- orchestrator retry or continuation policy redesign
- tracker adapter changes
- workspace lifecycle changes
- background execution providers
- Claude-specific adapter semantics beyond reserving a clean seam for `#91`

## Layering Notes

- `config/workflow`
  - owns typed runner selection and validation
  - does not infer backend choice from tracker state or orchestrator conditions
- `tracker`
  - remains isolated from runner/backend details
  - does not branch on selected runner kind
- `workspace`
  - continues to prepare filesystem state only
  - does not choose the runner or inject backend-specific prompts
- `runner`
  - owns backend-specific subprocess/session behavior behind the provider-neutral contract
  - does not render prompts, mutate tracker state, or make retry decisions
- `orchestrator`
  - consumes only `Runner`
  - does not branch on runner/backend kind
- `observability`
  - keeps using normalized runner session descriptions
  - does not parse backend-specific raw logs to learn which provider ran

## Slice Strategy And PR Seam

This should fit in one reviewable PR by keeping the change on the config-plus-execution seam:

1. add explicit runner selection to workflow parsing
2. extract explicit Codex and generic command runner implementations behind the existing runner contract
3. wire runtime construction through a runner factory
4. prove the seam with targeted tests and docs updates

This remains reviewable because it does not combine:

- new tracker behavior
- orchestrator state-machine changes
- remote execution plumbing
- a Claude-specific adapter

Issue `#91` can then add a concrete Claude backend against the same seam without reopening config or orchestrator design.

## Runtime State Model

This issue does not change orchestrator retries, reconciliation, handoff states, leases, or continuation budgeting, so no new orchestrator runtime state machine is required.

The relevant execution-layer lifecycle stays the existing runner-session model from `#89`:

- `idle -> starting -> running -> completed|failed -> closed`

Additional rule for this slice:

- runner selection occurs once during runtime wiring from resolved workflow config and is immutable for the lifetime of that orchestrator process

## Failure-Class Matrix

This slice does not change tracker recovery or orchestration failure handling. The main new failure surface is config/runtime selection at the execution boundary.

| Observed condition                                                     | Local facts available                 | Normalized facts available                    | Expected decision                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW.md` selects an unsupported runner kind                       | raw front matter                      | config parse context                          | fail workflow loading with a config error before orchestrator startup                                                              |
| Codex runner selected without required Codex-compatible command/config | resolved agent runner config          | runner construction error                     | fail runner construction at startup or session start; do not add orchestrator branching                                            |
| Generic command runner selected with a valid command                   | resolved agent runner config          | provider-neutral runner contract              | launch through generic command runner with normalized spawned/result/session data                                                  |
| Generic command runner asked for continuation turns                    | resolved runner kind plus `max_turns` | provider-neutral turn result/session metadata | continue through generic runner contract; cold-starting a subprocess per turn is acceptable and should stay inside runner behavior |
| CLI/runtime wiring receives resolved config for Codex                  | resolved runner kind                  | provider-neutral runner instance              | construct Codex runner and pass it to orchestrator without any backend-specific coordinator logic                                  |

## Observability Requirements

- preserve normalized `RunnerSessionDescription` fields across both backends
- ensure generic command runs produce stable provider metadata, even when the command is not Codex
- keep existing spawn-event behavior so issue artifacts, status snapshots, and watchdog logic remain unaffected
- document the selected backend in a repo-owned config shape rather than leaving it implicit in free-form command strings

## Implementation Steps

1. Add typed runner-selection config in `src/domain/workflow.ts`.
2. Update `src/config/workflow.ts` to parse and validate the runner selection seam while preserving current defaults/backward compatibility where appropriate for existing workflows/tests.
3. Refactor `src/runner/local.ts` into explicit runner implementations:
   - Codex-backed runner keeping current continuation/session behavior
   - generic command runner for arbitrary local commands
4. Add a runner factory in `src/runner/` that maps resolved workflow config to a concrete `Runner`.
5. Update CLI/runtime wiring to use the runner factory instead of constructing `LocalRunner` directly.
6. Update or split tests so they cover:
   - workflow parsing and defaults
   - runner factory selection
   - Codex runner behavior
   - generic command runner behavior
7. Update README and checked-in workflow examples to describe runner selection.

## Tests And Acceptance Scenarios

### Unit tests

- workflow config accepts an explicit Codex runner selection and resolves the expected typed config
- workflow config accepts an explicit generic command runner selection and resolves the expected typed config
- workflow config rejects unsupported runner kinds or malformed backend-specific fields
- runner factory returns the Codex runner when the workflow selects Codex
- runner factory returns the generic command runner when the workflow selects the generic command path
- generic command runner describes sessions/results without Codex-specific session assumptions
- Codex runner continues to expose Codex provider metadata and continuation-session behavior

### Integration / end-to-end coverage

- existing bootstrap/linear e2e tests stay green when configured to use Codex
- add one focused e2e-style path or integration test that exercises a workflow selecting the generic command runner through runtime wiring, without requiring orchestrator changes

### Acceptance scenarios

1. A workflow explicitly selecting Codex still starts the existing Codex-backed path and the orchestrator consumes only a `Runner`.
2. A workflow explicitly selecting a generic command runner launches an alternate local CLI command and completes through the same orchestrator path.
3. The CLI/runtime chooses the configured backend during startup; no orchestrator code branches on backend kind.
4. Status and artifact surfaces continue to receive normalized runner metadata regardless of which backend ran.

## Exit Criteria

- `WORKFLOW.md` can select at least two local runner/backend options through typed config
- one option preserves current Codex behavior
- one option launches an alternate local CLI through a generic command runner path
- runtime wiring selects the backend outside the orchestrator
- tests cover config parsing and runner selection behavior
- README / workflow docs describe the new seam clearly enough for `#91` to build on it

## Deferred To Later Issues Or PRs

- Claude Code-specific adapter and result semantics from `#91`
- richer provider capability modeling, such as explicit session-reuse capabilities or backend feature flags
- remote/background runner implementations
- policy for choosing backends dynamically per issue, per label, or by resource pressure
