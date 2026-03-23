# Issue 215 Plan: Multi-Instance CLI And Detached Control Selection

## Status

- plan-ready

## Goal

Add a first-class CLI selection surface so one Symphony engine checkout can target a specific project-local instance by `WORKFLOW.md` path across one-shot commands, detached factory control, and the checked-in operator loop without depending on the current working directory.

This slice should make the selected instance explicit in command parsing, command dispatch, and operator-loop wiring while continuing to use the instance-rooted runtime contract from issue `#214`.

## Scope

- define one supported instance-selection mechanism for the main CLI and operator loop
- make `run` and `status` consume that mechanism consistently with existing `--workflow` behavior
- extend `factory start|stop|restart|status|watch` to consume the same explicit selection mechanism instead of resolving only from `cwd`
- thread the selected workflow path through detached-control path resolution so runtime control operates on the intended project-local instance
- add operator-loop support for targeting a specific project-local workflow from the engine checkout
- update command usage/help text and focused docs so the engine-instance distinction is explicit
- add focused unit and integration coverage for cross-instance command targeting

## Non-goals

- tracker transport, normalization, or lifecycle policy changes
- orchestrator retry, continuation, reconciliation, lease, or handoff-state changes
- detached-session collision handling beyond selecting the intended instance
- operator scratchpad redesign or relocation
- broad README/runbook expansion beyond the minimal selection contract needed for this slice
- packaging or installation UX work beyond the checked-in scripts

## Current Gaps

- `src/cli/index.ts` supports `--workflow` for `run` and `status`, but `factory` commands still infer the target instance from `cwd`
- `src/cli/factory-control.ts` exposes `resolveFactoryPaths()` around filesystem discovery, but it does not accept an explicit workflow path when the operator wants to control another instance from the engine checkout
- `src/cli/factory-watch.ts` inherits the same implicit-instance behavior through `inspectFactoryControl()`
- `skills/symphony-operator/operator-prompt.md` and `skills/symphony-operator/operator-loop.sh` assume the repo containing the engine checkout is also the active instance because they call `symphony factory ...` from the operator repo root without an explicit workflow selector
- current help text and usage strings do not explain how to target a project-local instance when the command is launched from outside that instance root
- existing tests cover `cwd`-based detached-control resolution, but they do not lock in an explicit selection contract that protects one instance from accidental control of another

## Decision Notes

- Reuse `--workflow <path>` as the single supported instance-selection surface for this slice rather than introducing both `--workflow` and `--instance`. `run`, `status`, and report commands already use `--workflow`, so extending that flag keeps the CLI smaller and more coherent.
- Keep omission behavior conservative: when `--workflow` is not provided, existing commands may continue to resolve from `cwd` as today. The new value of this issue is explicit targeting, not removing ergonomic local defaults.
- Treat the selected `WORKFLOW.md` as the authoritative selector. Detached factory control should resolve runtime paths from that workflow's instance contract instead of searching from the current shell location.
- Keep operator-loop support explicit and script-friendly. The loop should accept and publish the chosen workflow path so unattended operation against a project-local instance is inspectable.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned CLI contract that `--workflow <path>` is the supported explicit instance selector for main CLI commands and the checked-in operator loop
  - belongs: the rule that omitted selection falls back to current behavior, while explicit selection always wins over `cwd`
  - does not belong: path walking, shell argument parsing helpers, or detached process inspection internals
- Configuration Layer
  - belongs: resolving the selected workflow path to typed instance paths through existing workflow loading and instance-path derivation
  - does not belong: detached process control, tracker reads, or operator scratchpad state
- Coordination Layer
  - belongs: ensuring `run`, `status`, and detached control operate on the same selected instance context for a given invocation
  - does not belong: retry budgeting, reconciliation rules, or new runtime-state machines
- Execution Layer
  - belongs: using the selected instance's runtime root when launching, stopping, or watching the detached worker
  - does not belong: runner semantics changes or cross-instance process arbitration
- Integration Layer
  - belongs: shell/script integration for the operator loop so it can pass the selected workflow path into the supported CLI commands
  - does not belong: tracker protocol changes or new host-service dependencies
- Observability Layer
  - belongs: rendering the selected workflow/instance path clearly enough in command output, status output, and operator-loop status files to prevent operator confusion
  - does not belong: inventing a second control-state schema or hidden selection state outside the checked-in contract

## Architecture Boundaries

### CLI parsing and dispatch

Belongs here:

- parsing `--workflow <path>` for `factory` actions in the same style as `run` and `status`
- validating incompatible argument combinations
- routing the selected workflow path into control/watch helpers

Does not belong here:

- re-deriving instance paths by hand
- shell discovery logic duplicated across commands

### Configuration / workflow loading

Belongs here:

- reusing `loadWorkflowInstancePaths()` and related helpers to resolve the selected instance
- centralizing any small workflow-path normalization helper needed by multiple commands

Does not belong here:

- detached screen process management
- operator-loop argument parsing

### Detached control

Belongs here:

- resolving factory paths from an explicit workflow path when provided
- falling back to current discovery behavior only when no explicit selector is passed
- keeping `factory start|stop|restart|status|watch` aligned on the same target resolution contract

Does not belong here:

- choosing among multiple instances heuristically once a workflow path is known
- new session-collision or lease-coordination policy

### Operator loop

Belongs here:

- accepting a workflow-path selector in `operator-loop.sh`
- publishing that selector in loop status metadata
- making the operator prompt and checked-in commands use the selected workflow explicitly

Does not belong here:

- changing operator scheduling policy
- moving `.ralph` or creating per-instance scratchpad storage in this slice

### Observability and docs

Belongs here:

- command output and usage text that show the selected instance clearly
- minimal README / operator-skill updates for the supported selection contract

Does not belong here:

- a broad onboarding rewrite
- unrelated status snapshot schema changes

## Slice Strategy And PR Seam

This issue should land as one reviewable PR focused on one seam: explicit instance selection plumbing for CLI entrypoints.

What lands in this PR:

1. a unified `--workflow <path>` selection contract for `run`, `status`, `factory`, and operator-loop-driven detached control
2. detached-control helper changes so explicit selection bypasses `cwd` discovery
3. operator-loop wiring and prompt/help text updates that make the selected instance explicit
4. focused tests proving commands target the intended project-local instance

What is deliberately deferred:

- multiple named instances or a separate `--instance` abstraction
- collision handling when different detached runtimes already exist
- per-instance operator scratchpads or loop status directories
- packaging/user-install ergonomics

This seam is reviewable because it stays on CLI/operator selection plumbing. It does not mix tracker edges, orchestrator state refactors, or runtime-layout redesign into the same patch.

## Instance Selection Resolution Model

This issue does not change orchestration retries, handoff states, or reconciliation. The stateful surface here is command-time instance targeting.

### States

1. `selector-omitted`
   - command invocation does not pass `--workflow`
2. `selector-provided`
   - command invocation includes a concrete `--workflow` path
3. `workflow-resolved`
   - the workflow path is normalized to an absolute path
4. `instance-resolved`
   - the workflow path yields typed instance/runtime paths
5. `command-dispatched`
   - `run`, `status`, `factory`, or operator-loop command executes against the resolved instance
6. `selection-failed`
   - the provided selector is missing, invalid, or cannot produce instance paths

### Allowed transitions

- `selector-omitted -> workflow-resolved`
  - via existing default `cwd`-relative behavior for commands that support it
- `selector-provided -> workflow-resolved`
- `workflow-resolved -> instance-resolved`
- `instance-resolved -> command-dispatched`
- `selector-provided -> selection-failed`
- `workflow-resolved -> selection-failed`
- `instance-resolved -> selection-failed`

### Contract rules

- when `--workflow <path>` is provided, command targeting must derive from that workflow path rather than from `cwd`
- all `factory` actions must share the same workflow-selection contract
- operator-loop invocations that target a project-local instance must pass the selected workflow explicitly into the supported CLI, not rely on `cd` gymnastics
- output and errors should name the selected workflow or instance root when helpful for diagnosis

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized instance facts available | Expected decision |
| --- | --- | --- | --- |
| `run --workflow /project/WORKFLOW.md` launched from the engine checkout | absolute workflow path | instance paths for `/project` | run against `/project` without depending on the engine checkout `cwd` |
| `factory status --workflow /project/WORKFLOW.md` launched outside the instance root | absolute workflow path | instance runtime root and status/startup paths | inspect `/project`'s detached runtime and never walk from caller `cwd` |
| `factory watch --workflow /project/WORKFLOW.md` launched from another repo | absolute workflow path | instance runtime root | watch the selected instance only |
| `factory start` omits `--workflow` and runs inside an instance root | caller `cwd` | discovered instance paths | preserve current local-default behavior |
| `factory ... --workflow /missing/WORKFLOW.md` | provided path only | none | fail clearly with workflow-path guidance; do not fall back to another discovered instance |
| operator loop is launched from the engine checkout with a target workflow path | operator-loop args/env, prompt path | selected instance paths | operator probes and control commands act on that project-local instance |
| two project repos exist on disk and one command selects one of them explicitly | provided workflow path, multiple repos nearby | one resolved instance contract | act on the selected instance only and keep outputs explicit enough to verify which one was chosen |

## Storage / Persistence Contract

- no new durable orchestration state is introduced
- operator-loop status files may record the selected workflow path and/or selected instance root as metadata for inspection
- detached runtime status/startup snapshots remain where the selected instance contract already places them
- no tracker-side persistence changes are introduced

## Observability Requirements

- `factory` output should continue to print the repository root and runtime root, which now must match the explicitly selected workflow when one is provided
- usage/help text should make clear that `--workflow <path>` can target a project-local instance from another checkout
- selection failures should mention the problematic workflow path instead of generic repo-root discovery failures
- operator-loop status JSON/Markdown should expose the selected workflow path when one is set so unattended operation is diagnosable

## Implementation Steps

1. Extend CLI argument parsing in `src/cli/index.ts` so `factory start|stop|restart|status|watch` accept `--workflow <path>` and carry that path through typed command args.
2. Refactor factory-control path resolution so `resolveFactoryPaths()` and callers can accept an explicit workflow path while preserving current `cwd` discovery when omitted.
3. Update `watchFactory()` and the `runCli()` factory dispatch path to pass the selected workflow path consistently to detached control helpers.
4. Extend `skills/symphony-operator/operator-loop.sh` with a workflow-path selector, likely `--workflow <path>`, and export/publish the resolved selection for the prompt and loop status.
5. Update `skills/symphony-operator/operator-prompt.md` and any minimal operator docs/help text so checked-in operator commands use the explicit selector when configured.
6. Update usage strings and minimal README/operator references so third-party users understand how to target a project-local instance from an engine checkout.
7. Add tests covering parse/dispatch behavior, explicit-vs-implicit resolution, operator-loop argument handling, and cross-instance command targeting.

## Tests And Acceptance Scenarios

### Unit tests

- `parseArgs()` accepts `--workflow <path>` for every `factory` action and preserves existing validation behavior
- `resolveFactoryPaths()` resolves the selected instance directly from an explicit workflow path without reading `cwd`
- explicit factory selection wins over a conflicting caller `cwd`
- explicit workflow selection failures mention the provided path and do not silently fall back to another instance
- operator-loop argument parsing accepts `--workflow <path>` and publishes the selection in status metadata

### Integration tests

- from an engine checkout, `runCli()` can execute `factory status --workflow <project>/WORKFLOW.md` against a separate temp project instance
- two temp project instances can coexist and an explicit factory command against one does not read the other's runtime files
- operator-loop script can run one cycle with a selected workflow path and emit status metadata that names the targeted instance

### End-to-end acceptance scenarios

1. Given a project repository with its own `WORKFLOW.md`, when an operator runs `pnpm tsx bin/symphony.ts run --workflow /project/WORKFLOW.md` from the engine checkout, then Symphony uses `/project` as the active instance.
2. Given two project repositories on disk, when an operator runs `pnpm tsx bin/symphony.ts factory status --workflow /project-b/WORKFLOW.md`, then the command inspects only project B's detached runtime and reports project B's repo/runtime roots.
3. Given the checked-in operator loop is launched with a project-local workflow path, when the prompt performs detached-control checks, then it acts on that selected project instance without requiring the shell `cwd` to be the project root.
4. Given `factory watch --workflow /missing/WORKFLOW.md`, when the selected workflow does not exist or cannot be loaded, then the command fails with explicit workflow-path guidance instead of probing another nearby instance.

## Exit Criteria

- `factory start|stop|restart|status|watch` all support explicit project-local instance targeting through `--workflow <path>`
- explicit selection flows through detached control and watch paths without relying on repo-root assumptions
- the checked-in operator loop can target a project-local instance from the engine checkout using the same selection contract
- command help/output makes the engine-vs-instance distinction explicit enough to avoid accidental cross-instance control
- focused tests cover explicit selection for CLI and operator entrypoints

## Deferred To Later Issues Or PRs

- a distinct `--instance` abstraction or named-instance registry
- cross-instance collision detection and arbitration for detached sessions
- per-instance operator scratchpad/log root isolation
- richer documentation or packaging for third-party distribution
