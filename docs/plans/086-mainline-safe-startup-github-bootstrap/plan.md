# Issue 86 Plan: Mainline Safe Startup For GitHub Bootstrap

## Status

- plan-ready

## Goal

Make startup hardening a repo-owned runtime contract instead of an optional wrapper path by moving the integration seam into the shared `symphony run` startup flow and exposing its progress/failure through the existing factory control surface.

This issue should decide and implement where startup preparation lives, how it is invoked for both foreground and detached runs, and how operators see startup failures without learning a second entrypoint such as `symphony-safe`.

## Scope

- add an explicit startup-preparation seam to the main `run` boot path
- make detached `factory start` and `factory restart` launch that same startup path rather than a parallel safe wrapper path
- define a typed startup-preparation contract that can host future GitHub mirror refresh work without coupling that logic directly to CLI parsing, workspace cloning, or tracker policy
- surface startup-in-progress and startup-failed outcomes through repo-owned status/control artifacts instead of only a detached-start timeout
- cover the startup contract with unit tests and at least one integration-style detached-start scenario
- update operator-facing docs so the supported entrypoints remain `symphony run` and `symphony factory ...`

## Non-goals

- implementing the full GitHub mirror refresh algorithm from closed PR `#75`
- redefining prompt trust policy or changing what issue/review text is rendered into `WORKFLOW.md` in this issue
- redesigning the detached factory control CLI introduced in `#81`
- redesigning guarded landing or merge gating from `#82`
- adding remote control-plane infrastructure or a second long-lived startup daemon

## Current Gaps

- closed PR `#75` proved one hardening direction, but only behind `bin/symphony-safe.ts`; that keeps startup safety optional and dependent on operator memory
- the checked-in runtime has no startup-preparation module or lifecycle contract; `runCli()` loads the workflow and immediately starts the runtime after the guardrail acknowledgement
- `factory start` launches `symphony run` and waits for a healthy status snapshot, but it cannot distinguish “startup preparation failed quickly” from “worker never became healthy before timeout”
- startup concerns currently have no dedicated status surface, so future mirror refresh work would either be hidden in a wrapper or scattered across CLI, workspace, and docs
- `workspace.repo_url` and workspace cloning are resolved before any explicit startup policy layer exists, which makes future hardening easy to bolt on in the wrong place

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that startup hardening, when configured for a tracker/runtime, must execute on the canonical `run` path rather than through an operator-only wrapper
  - belongs: the rule that detached control commands reuse the same startup path and surface its status/failure explicitly
  - does not belong: raw git subprocess details or screen-session detection
- Configuration Layer
  - belongs: typed startup-preparation config and resolution for future GitHub-bootstrap hardening modes
  - does not belong: running git commands or classifying detached control state
- Coordination Layer
  - belongs: startup lifecycle transitions before the orchestrator reaches healthy runtime service
  - belongs: deciding when startup is still preparing, failed terminally, or handed off to normal runtime status
  - does not belong: tracker API normalization or workspace git clone details
- Execution Layer
  - belongs: executing the startup-preparation step and writing any startup-status artifact needed before the orchestrator is live
  - does not belong: tracker policy, prompt policy, or merge gating
- Integration Layer
  - belongs: GitHub-bootstrap-specific startup preparation providers and any future git/mirror integration behind a narrow service contract
  - does not belong: detached CLI output wording or orchestrator retry policy
- Observability Layer
  - belongs: startup status/failure summaries visible through `factory status`, `factory start`, and local artifacts
  - does not belong: deciding whether startup hardening is required in the first place

## Architecture Boundaries

### CLI / boot seam

Belongs here:

- parse and preserve the existing `run` and `factory` entrypoints
- call one shared startup-preparation service from `runCli()` after config is resolved and before the orchestrator starts
- map startup preparation results to user-facing output and exit status

Does not belong here:

- tracker-specific startup policy logic
- git mirror sync implementation details
- workspace cloning mutations

### Configuration

Belongs here:

- resolve any startup-preparation settings from `WORKFLOW.md`
- keep the startup contract explicit and typed even if the first slice only wires a narrow GitHub-bootstrap mode

Does not belong here:

- `screen` control logic
- process liveness checks
- ad hoc environment-variable parsing spread across unrelated modules

### Startup service

Belongs here:

- a provider-neutral startup-preparation contract
- a coordinator that executes startup preparation once per `run` process
- startup result types such as `preparing`, `ready`, and `failed`
- writing a minimal startup artifact that detached control can read before the normal runtime snapshot is available

Does not belong here:

- long-running orchestrator polling logic
- workspace branch checkout/reset policy
- prompt rendering

### GitHub bootstrap integration

Belongs here:

- selecting the GitHub-bootstrap startup-preparation implementation from config/tracker context
- future mirror-refresh or source-material hardening behind the startup service contract

Does not belong here:

- detached control-state classification
- generic runtime startup state persistence unrelated to GitHub bootstrap

### Factory control / observability

Belongs here:

- reading startup status/failure alongside the existing status snapshot
- reporting detached startup as `starting`, `running`, `degraded`, or an explicit startup-failed state without relying only on timeouts

Does not belong here:

- re-running startup preparation itself
- owning the hardening policy separately from `run`

### Workspace / tracker / orchestrator

- workspace
  - may consume prepared startup outputs such as a resolved local source path if the startup contract produces one
  - must not run startup hardening itself
- tracker
  - may select tracker-specific startup preparation providers
  - must not own CLI boot policy or detached startup observability
- orchestrator
  - should start only after startup preparation has reached `ready`
  - must not absorb pre-orchestrator bootstrapping branches inline

## Decision Notes

- Choose the main `run` boot path as the integration point for startup hardening. `factory start` is an operator control seam, not the place to duplicate or specialize startup policy.
- Keep the first implementation slice narrow by adding the lifecycle seam and observability now, while deferring the full mirror algorithm itself. This issue is about placement and runtime ownership.
- Make startup status inspectable before the worker publishes the normal `.tmp/status.json` snapshot. Otherwise detached control can only report a timeout, which is too opaque for operators and too brittle for future control-plane work.

## Slice Strategy And PR Seam

This issue should stay one reviewable PR by landing one narrow startup-integration slice:

1. add a startup-preparation contract and boot coordinator used by `symphony run`
2. add the minimal status artifact / control-surface plumbing needed to observe startup progress and failure
3. update `factory start` / `factory status` to reflect the shared startup lifecycle
4. add focused tests and docs

Deferred from this PR:

- the full GitHub mirror refresh implementation from PR `#75`
- prompt-template trust-surface edits
- broader service-manager or remote-control startup orchestration
- merge-gate or landing-path changes from `#82`

This seam is reviewable because it stays inside startup placement, lifecycle, and operator visibility. It does not combine tracker transport, merge policy, or workspace branch-management redesign in the same patch.

## Runtime State Model

Startup behavior is stateful enough to require an explicit state model because detached control, foreground `run`, and future hardening providers all need the same interpretation.

### Startup states

1. `idle`
   - no active startup preparation is recorded for the current process
2. `preparing`
   - the shared startup coordinator is running pre-orchestrator startup tasks
3. `ready`
   - startup preparation completed successfully and control may hand off to normal runtime/orchestrator startup
4. `failed`
   - startup preparation reached a terminal failure and the process will exit non-zero

### Detached control projection

- `stopped`
  - no detached worker exists and no active startup artifact indicates in-progress work
- `starting`
  - detached worker exists and startup artifact reports `preparing`
- `running`
  - normal runtime snapshot is healthy after startup reached `ready`
- `degraded`
  - detached runtime is broken, startup failed, or artifacts/process facts disagree

### Allowed transitions

- `idle -> preparing`
- `preparing -> ready`
- `preparing -> failed`
- `ready -> idle`
  - handoff to the normal runtime loop or clean command completion
- `failed -> idle`
  - process exits and subsequent runs start fresh

### Decision facts

The startup/control seam should decide from:

- resolved workflow config and tracker kind
- startup artifact for the current runtime root
- detached process/session facts already used by `factory-control`
- the existing runtime status snapshot once available

The seam should not decide from:

- tracker issue labels
- workspace-local git state after issue checkout has started
- `.ralph` artifacts

## Failure-Class Matrix

| Observed condition                                                                 | Local facts available                       | Normalized startup/status facts available                   | Expected decision                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Foreground `symphony run` starts and startup preparation succeeds                  | current process only                        | startup artifact transitions `preparing -> ready`           | continue into normal orchestrator startup                                         |
| Foreground `symphony run` starts and startup preparation fails before orchestrator | current process only                        | startup artifact transitions `preparing -> failed`          | print clear startup failure, exit non-zero, do not start orchestrator             |
| `factory start` launches detached worker and startup is still running              | screen session and worker pid present       | startup artifact says `preparing`; no normal snapshot yet   | report `starting`; keep polling without misclassifying as timeout or stale status |
| `factory start` launches detached worker and startup fails quickly                 | detached session may exit soon after launch | startup artifact says `failed` with summary                 | fail fast with explicit startup-failure message instead of generic timeout        |
| Detached worker reaches normal runtime after startup                               | screen session and worker pid present       | startup `ready`; normal status snapshot becomes healthy     | report `running`                                                                  |
| No detached worker exists but stale startup artifact remains                       | no screen session, no worker pid            | startup artifact last state `preparing` or `failed`         | report `degraded` or stale-startup problem until cleaned/invalidated explicitly   |
| Startup artifact unreadable but detached worker is otherwise alive                 | screen session / pid present                | startup artifact missing or corrupt; normal snapshot absent | report `degraded` with startup-observability error                                |
| Non-GitHub tracker or no startup-preparation provider configured                   | current process only                        | startup coordinator resolves a no-op/ready provider outcome | continue without tracker-specific hardening path                                  |

## Storage / Persistence Contract

- add one small startup artifact under the existing runtime-owned temp area, separate from the long-lived normal status snapshot
- the artifact should capture:
  - startup state
  - timestamp
  - optional summary/message
  - optional provider identifier
- the startup artifact is transient runtime state, not a new system of record
- the existing `.tmp/status.json` snapshot remains the canonical healthy-runtime snapshot after startup completes
- startup artifact cleanup/invalidation should be explicit so detached control can distinguish a fresh startup from stale leftovers

## Observability Requirements

- `symphony run` must print a clear startup failure summary when startup preparation fails before the runtime becomes healthy
- `symphony factory start` must distinguish:
  - startup in progress
  - startup failed
  - generic detached-start timeout
- `symphony factory status` should include startup state/details when the runtime has not yet published a healthy status snapshot
- JSON control output should expose startup state in a machine-readable shape suitable for future control-plane work from `#81`
- structured logs should record startup preparation begin/succeed/fail with provider identity

## Implementation Steps

1. Add a focused startup module, for example under `src/startup/`, that defines:
   - startup status/result types
   - startup artifact read/write helpers
   - a coordinator that executes one provider per `run` invocation
2. Add a startup-preparation provider-selection seam based on resolved workflow config / tracker kind.
   - Keep the first provider narrow and GitHub-bootstrap-oriented.
   - Use a no-op provider where no startup hardening is configured or required.
3. Update `runCli()` so the canonical `run` path:
   - writes `preparing`
   - executes startup preparation
   - writes `ready` or `failed`
   - starts the orchestrator only after `ready`
4. Update `src/cli/factory-control.ts` to:
   - read the startup artifact
   - classify detached control state as `starting`, `running`, or `degraded` accordingly
   - fail fast on recorded startup failure instead of waiting only for timeout
5. Extend human-readable and JSON control/status rendering to surface startup state and failure details clearly.
6. Update docs in `README.md` and `docs/guides/self-hosting-loop.md` so operators are directed only to `symphony run` and `symphony factory ...` as the supported startup paths.
7. Add focused tests:
   - startup artifact parsing/rendering
   - boot-coordinator behavior on success/failure
   - `factory start` / `status` behavior for `preparing` and `failed`
   - integration-style detached startup case

## Tests And Acceptance Scenarios

### Unit

- startup coordinator writes `preparing` before provider execution and `ready` after success
- startup coordinator writes `failed` with a surfaced message when provider execution throws
- `runCli()` exits non-zero and does not construct/start the orchestrator when startup preparation fails
- factory-control state classification reports `starting` when a detached worker exists and startup is still `preparing`
- factory-control start/status surface a recorded startup failure distinctly from a generic timeout
- JSON control rendering includes startup-state fields when no healthy runtime snapshot exists yet

### Integration

- a fake startup provider that blocks briefly lets `factory start` observe `starting` before the normal runtime snapshot appears
- a fake startup provider failure causes `factory start` to return a clear startup-failure result instead of timing out
- a normal no-op startup provider still allows existing detached startup to reach `running`

### End-to-End

1. An operator runs `pnpm tsx bin/symphony.ts run --once`; the repo-owned startup coordinator runs first and the normal runtime starts only after startup preparation reports `ready`.
2. An operator runs `pnpm tsx bin/symphony.ts factory start`; while startup preparation is still running, `factory status` reports startup in progress instead of a missing snapshot error.
3. Startup preparation fails before orchestrator boot; `factory start` and `factory status` show the recorded failure clearly and the operator does not need a separate safe entrypoint to reproduce or inspect it.
4. The supported docs direct operators to the canonical mainline entrypoints and no checked-in wrapper entrypoint is required.

## Exit Criteria

1. startup preparation has one repo-owned invocation path through `symphony run`
2. detached factory control launches and reports that same path rather than a separate wrapper contract
3. startup-in-progress and startup-failed outcomes are explicit and testable
4. operators no longer need to remember an out-of-band safe startup entrypoint
5. the startup seam is compatible with future GitHub mirror work and control-plane status work
6. docs and tests reflect the supported startup lifecycle

## Deferred To Later Issues Or PRs

- concrete GitHub mirror refresh/verification logic behind the startup-preparation provider
- prompt hardening and trust-surface changes from the original PR `#75`
- any workflow-level policy that decides which GitHub-authored content is trusted in prompts
- broader control-plane commands or remote factory supervision beyond the existing `factory` surface
