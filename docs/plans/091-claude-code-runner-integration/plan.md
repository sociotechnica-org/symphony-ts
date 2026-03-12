# Issue 91 Plan: Claude Code Runner Integration For Local Factory Runs

## Status

- plan-ready

## Goal

Add a first-class Claude Code local runner path on top of the provider-neutral runner seam from `#89` and the workflow-owned runner selection seam from `#90`, so a local Symphony factory run can execute a real issue through Claude Code when Codex capacity is constrained.

## Scope

- add an explicit Claude Code runner kind and typed configuration under `agent.runner`
- implement a Claude Code runner adapter that launches the local `claude` CLI in headless mode through the existing runner contract
- preserve prompt delivery through the existing prompt transport seam while defining the minimum supported Claude command shape
- support Claude continuation turns through the runner live-session seam when `agent.max_turns > 1`
- keep normalized runner session metadata and spawn events usable by the existing status/artifact/report surfaces
- add tests for workflow parsing, runner factory selection, Claude command execution/session behavior, and one real local validation path
- document the `WORKFLOW.md` shape and local prerequisites for selecting Claude Code explicitly

## Non-goals

- hosted or background Claude execution
- remote workspace lifecycle changes
- dynamic backend-routing policy across multiple providers
- tracker transport, normalization, or policy changes
- orchestration retry, lease, reconciliation, or handoff-policy redesign
- broad observability redesign beyond the minimum normalized metadata needed to keep local runs inspectable
- runner-log report enrichment for Claude session artifacts

## Current Gaps

- `src/domain/workflow.ts` only models `codex` and `generic-command` runner kinds
- `src/config/workflow.ts` rejects `agent.runner.kind: claude-code` today
- `src/runner/factory.ts` cannot construct a Claude-specific runner
- the current generic command path can launch arbitrary CLIs, but it does not encode the Claude-specific command invariants we need for a reliable local fallback:
  - headless execution flags
  - permission-mode expectations
  - continuation-session resume behavior
  - normalized provider/model/session metadata
- README and checked-in workflow examples describe only Codex or a generic command path, not an explicit Claude selection contract
- there is no test or validation path proving a full local factory issue can run through Claude Code

## Decision Notes

- Keep Claude as an explicit execution-layer adapter rather than documenting it as a generic command recipe. We need a stable workflow contract and normalized session metadata, not a stringly-typed convention.
- Reuse the existing subprocess execution helpers instead of introducing a second process-launch stack.
- Treat the minimum supported Claude command shape as repo-owned configuration:
  - non-interactive print mode
  - explicit working directory
  - a non-blocking permission configuration suitable for local factory runs
- Keep Claude-specific CLI normalization inside `src/runner/`; do not leak Anthropic CLI flags into orchestrator policy.
- Prefer a narrow adapter that validates required Claude flags and constructs continuation commands centrally, instead of scattering command-shape checks across config, tests, and docs.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: the repo-owned decision that Claude Code is a supported local backend and must be selected explicitly in `WORKFLOW.md`
  - does not belong: raw CLI flag parsing, subprocess launch mechanics, or tracker handoff behavior
- Configuration Layer
  - belongs: typed `agent.runner.kind: claude-code`, any minimal Claude-specific nested config, and validation of supported workflow-owned settings
  - does not belong: process spawning, session discovery, or tracker mutations
- Coordination Layer
  - belongs: unchanged consumption of the provider-neutral `Runner` contract and existing continuation/retry policy
  - does not belong: branching on Claude-specific flags, provider resume rules, or command rewriting
- Execution Layer
  - belongs: Claude runner adapter, command validation/building, continuation-session behavior, and normalized Claude session metadata
  - does not belong: prompt template rendering, tracker lifecycle updates, or backend-routing policy
- Integration Layer
  - belongs: untouched in this slice
  - does not belong: Claude CLI details or workflow runner selection
- Observability Layer
  - belongs: preserving normalized provider/model/session metadata so status, issue artifacts, and reports remain operable
  - does not belong: parsing raw Claude CLI output in status/reporting code to infer provider behavior

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - add a typed Claude runner config variant
- `src/config/workflow.ts`
  - parse and validate the Claude workflow selection seam
- `src/runner/`
  - add a Claude runner implementation
  - add Claude command parsing/validation helpers
  - add Claude continuation/resume command handling if supported by the CLI seam
  - update runner factory wiring
- tests
  - workflow parsing
  - runner factory selection
  - Claude runner behavior and continuation semantics
  - focused e2e/local validation coverage for a factory run using Claude
- docs
  - README and `WORKFLOW.md` examples for explicit Claude selection

### Does not belong in this issue

- tracker API changes
- orchestrator state-machine changes
- workspace lifecycle changes beyond what existing runner execution already uses
- status-surface redesign
- report-enricher work for Claude logs
- dynamic provider selection or automatic fallback between Codex and Claude

## Layering Notes

- `config/workflow`
  - owns typed Claude selection and validation
  - does not infer tracker policy or mutate runner commands at runtime based on issue state
- `tracker`
  - remains isolated from runner selection and Claude-specific metadata
  - does not special-case Claude-backed issues
- `workspace`
  - continues to provide filesystem context only
  - does not own Claude CLI flag policy or session reuse behavior
- `runner`
  - owns Claude command validation, launch behavior, continuation-session handling, and normalized metadata
  - does not render prompts, write tracker comments, or decide retries
- `orchestrator`
  - keeps consuming only the `Runner` interface
  - does not branch on `claude-code`
- `observability`
  - keeps consuming normalized runner metadata
  - does not become a second Claude adapter

## Slice Strategy And PR Seam

This should land as one reviewable PR by keeping the seam limited to workflow config, the runner adapter, tests, and docs:

1. add typed Claude workflow selection
2. implement the Claude runner adapter behind the existing runner contract
3. prove the path with focused unit/integration coverage and one local factory validation path
4. document the supported `WORKFLOW.md` contract and prerequisites

This remains reviewable because it does not combine:

- tracker-policy changes
- orchestrator runtime-state refactors
- workspace lifecycle redesign
- broader provider capability modeling
- report/archive enrichment work

If local validation shows that Claude requires broader visibility or artifact changes, capture that as a follow-up issue instead of expanding this PR.

## Runner Session State Model

This issue does not change orchestrator retries, reconciliation, leases, or handoff states. The stateful surface is the Claude execution-layer session lifecycle behind the existing `LiveRunnerSession` seam.

### States

- `idle`
  - Claude runner exists but no turn has started
- `starting`
  - Claude subprocess command for the current turn is being prepared and launched
- `running`
  - the turn is active and spawn metadata may be emitted
- `completed`
  - a turn finished with a normalized result
- `failed`
  - command validation, launch, or session-discovery/resume failed
- `closed`
  - no additional turns will execute in this live session

### Allowed transitions

- `idle -> starting`
- `starting -> running`
- `starting -> failed`
- `running -> completed`
- `running -> failed`
- `completed -> starting`
  - for continuation turns
- `completed -> closed`
- `failed -> closed`

### Contract rules

- turn 1 must use a Claude-compatible headless command shape
- continuation turns may reuse Claude conversation state only through a runner-owned resume mechanism; the orchestrator must stay unaware of Claude CLI details
- if Claude cannot provide a reusable backend session id for continuation, the runner must fail explicitly rather than silently changing continuation semantics
- normalized session metadata may set `model` or `backendSessionId` to `null` only when those facts are unavailable from the supported Claude command/result seam

## Failure-Class Matrix

| Observed condition                                                                                                                | Local facts available                      | Normalized facts available                         | Expected decision                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `WORKFLOW.md` selects `claude-code` with an unsupported or malformed command shape                                                | workflow config, command string            | config parse / runner construction context         | fail fast during startup or runner construction with a config/runner error                                          |
| Claude runner is selected but `claude` is not installed or not executable                                                         | command string, spawn error                | process launch failure                             | use existing orchestrator run-failure path; no tracker-policy change                                                |
| Claude headless turn exits non-zero                                                                                               | workspace path, turn number                | normalized run result with exit code/stdout/stderr | use existing orchestrator failure handling                                                                          |
| Claude turn succeeds but no resumable session id is discoverable while `agent.max_turns > 1` and a continuation turn is requested | prior successful turn result, runner state | missing `backendSessionId` after success           | fail at the runner adapter boundary; do not silently cold-start unless the documented contract explicitly allows it |
| Claude run succeeds in one turn                                                                                                   | command config, workspace path             | normalized provider/model/session metadata         | complete through the existing orchestrator path                                                                     |
| Claude output omits optional model metadata                                                                                       | command/result output                      | provider known, model unknown                      | preserve `provider: claude-code`, set `model: null`, keep status surfaces working                                   |

## Storage / Persistence Contract

- no new durable tracker state is introduced
- existing issue artifact/status persistence should keep consuming normalized runner spawn/session/result metadata
- if Claude session ids or log pointers are available, store them through the existing provider-neutral session shape rather than a Claude-only artifact schema
- report enrichment for Claude-specific logs is explicitly deferred

## Observability Requirements

- session descriptions for Claude runs must identify the provider as `claude-code`
- preserve spawn events so watchdog/status/artifact flows continue to work
- capture model and backend session id when the supported Claude CLI path exposes them
- keep logs and status readable even if Claude metadata is partially unavailable
- update docs to make the supported headless command shape inspectable by operators

## Implementation Steps

1. Extend workflow domain/config parsing with an explicit `claude-code` runner kind and any minimal Claude-specific config needed to validate the local CLI contract.
2. Add Claude command helper(s) in `src/runner/` to:
   - identify Claude commands
   - validate the supported headless command shape
   - extract normalized metadata when available
   - build continuation/resume commands if the CLI supports them
3. Implement `ClaudeCodeRunner` behind the existing `Runner` contract, reusing the shared local execution helper and live-session seam.
4. Update `src/runner/factory.ts` to construct the Claude runner from resolved workflow config.
5. Add or update tests for:
   - workflow parsing and validation
   - runner factory selection
   - Claude one-shot execution
   - Claude continuation-session behavior
   - failure handling for malformed config or missing continuation metadata
6. Add one focused end-to-end or integration-style path that exercises a factory run configured for Claude through the existing local orchestration path.
7. Update README and checked-in `WORKFLOW.md` documentation with the explicit Claude selection contract, prerequisites, and a minimal example.
8. Run a real local validation flow against a local issue/repo path using Claude Code and record any follow-up gaps separately if they are outside this slice.

## Tests And Acceptance Scenarios

### Unit tests

- workflow config accepts `agent.runner.kind: claude-code` with the supported command/config shape
- workflow config rejects malformed Claude runner config or unsupported command expectations
- runner factory returns `ClaudeCodeRunner` when the workflow selects Claude
- Claude runner describes sessions with `provider: claude-code`
- Claude live session reuses the backend session when continuation turns are supported
- Claude runner fails clearly when continuation is requested but resumable session metadata is unavailable

### Integration / end-to-end coverage

- keep existing Codex and generic-command tests green
- add one focused integration or e2e fixture that runs the factory with `agent.runner.kind: claude-code`
- add one local validation run against the real Claude CLI if available in the operator environment; if that validation cannot run in CI, record it in issue/PR notes while keeping automated coverage on mocked/subprocess seams

### Acceptance scenarios

1. A workflow explicitly selecting Claude starts the Claude runner path without orchestrator branching.
2. A local factory run can execute a real issue through Claude Code and reach the same handoff path used by other runners.
3. Prompt delivery still works through the configured transport for Claude’s supported headless mode.
4. Status and issue artifacts remain inspectable with normalized Claude session metadata.
5. Existing Codex and generic-command paths remain unaffected.

## Exit Criteria

- `WORKFLOW.md` can select Claude explicitly through typed config
- runtime wiring constructs a Claude runner outside the orchestrator
- Claude can execute the factory prompt in headless local mode
- continuation turns are either supported explicitly through the adapter or rejected with a documented, tested boundary error
- automated tests cover workflow selection and Claude runner behavior
- docs describe the supported local Claude setup clearly enough for operators to use it as a fallback backend
- any richer visibility or remote follow-ups are captured separately instead of folded into this PR

## Deferred To Later Issues Or PRs

- Claude-specific report/log enrichment
- remote or background Claude execution
- provider capability negotiation beyond the minimum needed for this local slice
- dynamic backend fallback/routing policy
- visibility redesign for provider-specific progress details
