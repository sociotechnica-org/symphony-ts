# Issue 188 Plan: Add Host-Aware Dispatch, Retry Continuity, And Mocked Remote End-To-End Coverage

## Status

- plan-ready

## Goal

Add the first explicit host-dispatch coordination policy for remote Codex SSH execution so Symphony can:

- choose among configured worker hosts at dispatch time,
- preserve same-host continuity for live continuation turns and failure retries when that host is still usable,
- expose host occupancy and host-pressure posture through status surfaces,
- and prove the real orchestration flow with mocked multi-host remote end-to-end coverage.

This slice should build directly on the remote-capable seams from `#182`, `#183`, `#184`, and `#187` without pushing host selection into tracker adapters or runner transport internals.

## Scope

- extend typed workflow config for remote Codex host dispatch beyond one fixed `worker_host`
- add an explicit host-dispatch runtime-state module in `src/orchestrator/` that tracks:
  - configured eligible hosts
  - current host occupancy
  - continuity preference for active runs and queued retries
  - degraded "no host available" posture
- preserve same-host continuity for:
  - continuation turns within one live run
  - retry attempts when the prior host is still configured and not currently occupied
  - restart recovery when a healthy inherited remote run already owns a host
- keep host choice explicit on the prepared workspace / execution-owner path so observability can report the selected host and occupancy clearly
- add status/TUI projection for host occupancy and host-related dispatch pressure when relevant
- add mocked unit/integration/e2e coverage that exercises multi-host remote dispatch and retry continuity through the normal factory flow
- update README and directly relevant docs for host-pool config, continuity behavior, and degraded cases when no host is dispatchable

## Non-goals

- implementing multi-instance cross-host coordination or distributed lease election
- introducing a generic remote scheduler for every runner provider
- changing tracker transport, normalization, or lifecycle policy
- redesigning runner continuation semantics inside the Codex app-server transport
- adding hosted remote task backends, SSH multiplexers, or remote daemon infrastructure
- changing workspace retention policy beyond what host continuity and observability require
- broad retry/backoff redesign unrelated to host continuity

## Current Gaps

- `src/config/workflow.ts` resolves `agent.runner.remote_execution.worker_host` to one concrete host, so the config/runtime seam cannot express host-aware scheduling over `workspace.worker_hosts`.
- `src/cli/index.ts`, `tests/e2e/bootstrap-factory.test.ts`, and `src/runner/factory.ts` thread one `remoteWorkerHost` object straight through workspace and runner construction, which hardwires host choice before orchestration begins.
- `src/workspace/remote-ssh.ts` owns one configured worker host for its lifetime, so workspace preparation cannot consume a dispatch-time host selection.
- `src/orchestrator/state.ts`, `retry-state.ts`, and `dispatch-pressure-state.ts` do not represent host occupancy or host-affinity continuity explicitly.
- `src/orchestrator/service.ts` can already preserve a live remote session for continuation turns inside one run, but retries and redispatch have no typed memory of the last good remote host.
- status surfaces project execution-owner and global provider-pressure facts, but they do not show which remote hosts are occupied, preferred for continuity, or blocking dispatch because the pool is exhausted.
- existing mocked remote e2e coverage proves one remote SSH run on one host, but it does not prove:
  - host selection from a pool
  - same-host retry continuity
  - degraded dispatch when all eligible hosts are occupied or unavailable

## Decision Notes

- Keep host selection in the coordination layer as an explicit runtime policy. The orchestrator should decide which configured host to use; the workspace and runner should consume that decision through typed execution inputs.
- Keep host affinity explicit and narrow:
  - active continuation turns stay on the same host because they reuse one live workspace/session
  - failure retries prefer the previous host when safe, but may fall back to another eligible host when continuity is unavailable
  - host continuity must not become a tracker concern
- Treat "no host currently available" as dispatch posture, not as a tracker failure. The issue should remain queued/running according to existing lifecycle semantics while status surfaces make the host bottleneck explicit.
- Reuse the existing remote SSH workspace and Codex app-server transport seams. This issue should refactor host selection around them, not rebuild them.
- Keep the first slice Codex SSH only. Claude and generic-command remote scheduling remain deferred until this host-dispatch seam is proven.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repository-owned rule that remote host selection, continuity preference, and degraded no-host posture are explicit orchestration policy
  - belongs: the rule that same-host continuity is preferred for retries when safe, but not required when another eligible host can make progress
  - does not belong: SSH subprocess composition, git workspace commands, or tracker API branching
- Configuration Layer
  - belongs: parsing and validating a remote host-pool selection shape from `WORKFLOW.md`
  - does not belong: live host occupancy, retry-affinity decisions, or status publication
- Coordination Layer
  - belongs: host selection, occupancy bookkeeping, retry continuity rules, dispatch/posture decisions, and restart adoption of host-owned runs
  - does not belong: SSH command execution, remote git preparation, or Codex protocol parsing
- Execution Layer
  - belongs: preparing a workspace on a chosen host and starting a runner session against that chosen host
  - does not belong: deciding which host should be chosen or when continuity may be broken
- Integration Layer
  - belongs: unchanged tracker inputs/outputs consumed by the orchestrator
  - does not belong: host scheduling state, host pressure, or retry continuity
- Observability Layer
  - belongs: rendering host occupancy, preferred-host continuity, selected-host identity, and degraded no-host posture
  - does not belong: inventing host policy or recovering hidden scheduler state from raw logs

## Architecture Boundaries

### `src/config/`

Owns:

- typed remote host-pool workflow config
- validation that remote host references resolve to `workspace.worker_hosts`
- any explicit policy knobs needed for continuity preference or fallback order

Does not own:

- current occupancy
- retry affinity
- dispatch decisions

### `src/orchestrator/`

Owns:

- the host-dispatch runtime-state module
- host occupancy transitions for active runs
- continuity preference for retries and inherited active runs
- degraded no-host posture and any host-specific dispatch pressure summary

Does not own:

- SSH command construction
- remote workspace implementation details
- tracker-specific policy

### `src/workspace/`

Owns:

- preparing or cleaning a workspace on the host selected by the orchestrator
- returning normalized host/workspace identity for observability and execution-owner persistence

Does not own:

- selecting the host
- continuity policy
- retry decisions

### `src/runner/`

Owns:

- starting Codex over SSH stdio on the already-selected host
- preserving the live same-host session within one run
- reporting normalized transport/session facts for the selected host

Does not own:

- pool selection
- host occupancy bookkeeping
- retry host preference

### `src/observability/`

Owns:

- status snapshot schema/projection for host occupancy and no-host posture
- TUI/status rendering for selected host and host bottlenecks
- artifact/session projection of the chosen host where already available in execution-owner/session metadata

Does not own:

- dispatch decisions
- scheduler state transitions

## Layering Notes

- `config/workflow`
  - resolves host-pool config and fallback policy
  - does not carry live chosen-host state
- `tracker`
  - stays unchanged and continues supplying normalized issue/pr state
  - does not learn about worker-host pool semantics
- `workspace`
  - consumes an explicit selected host
  - does not infer selection from runner config
- `runner`
  - executes on the selected host
  - does not query global host availability
- `orchestrator`
  - owns host occupancy, retry affinity, and degraded dispatch posture
  - does not parse SSH command flags or workspace shell scripts
- `observability`
  - reports host state already normalized by orchestrator/workspace/runner
  - does not become the source of truth for host scheduling

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one coordination-centered seam:

1. move remote host selection from static runner construction to explicit orchestration/runtime state
2. make remote workspace/runner execution consume a selected host instead of a prebound one
3. add retry continuity and host occupancy/status projection
4. prove the behavior with mocked multi-host remote e2e coverage

Deferred from this PR:

- provider-neutral host scheduling for non-Codex runners
- cross-factory host coordination across multiple Symphony instances
- remote host health probes beyond immediate run/SSH outcomes
- sophisticated balancing heuristics beyond deterministic selection plus continuity preference
- tracker-surface changes for host state

This seam stays reviewable because it focuses on one orchestration policy change and only the execution/observability plumbing required to honor that policy.

## Runtime State Machine

This issue changes stateful orchestration around dispatch, retries, and remote host continuity, so an explicit host-dispatch state machine is required.

### State variables

- `eligibleHosts`
  - validated worker hosts available to the remote Codex runner
- `hostOccupancy`
  - map of host name to current owning issue/run session, if any
- `preferredHostByIssue`
  - last successful or inherited remote host that should be preferred for continuity
- `retryQueue`
  - queued retries that may carry preferred-host affinity
- `dispatchPosture`
  - whether dispatch is free, continuity-constrained, or blocked by no available host

### States

1. `idle`
   - no remote-dispatchable issue is currently selecting a host
2. `selecting-host`
   - an issue is evaluating eligible hosts, occupancy, and continuity preference
3. `host-reserved`
   - one host has been reserved for workspace preparation and run startup
4. `running-on-host`
   - the issue owns a host and may perform continuation turns on that same host
5. `waiting-on-host`
   - the run is blocked on PR/review/check/external state but still occupies the host because the live session remains active
6. `retry-queued-with-affinity`
   - the run ended in a retryable failure and carries a preferred host for its next attempt
7. `retry-queued-without-affinity`
   - the run ended in a retryable failure but the prior host is unavailable, unconfigured, or continuity should not be preserved
8. `dispatch-blocked-no-host`
   - the issue is ready to run remotely but no eligible host is currently dispatchable
9. `degraded-host-missing`
   - continuity points at a host that is no longer configured or cannot be normalized safely
10. `terminal`

- the issue completed, failed terminally, or was handed off and no longer occupies a host

### Allowed transitions

- `idle -> selecting-host`
- `selecting-host -> host-reserved`
- `selecting-host -> dispatch-blocked-no-host`
- `selecting-host -> degraded-host-missing`
- `host-reserved -> running-on-host`
- `host-reserved -> retry-queued-without-affinity`
  - startup failed before a durable same-host continuity point exists
- `running-on-host -> waiting-on-host`
- `running-on-host -> retry-queued-with-affinity`
- `running-on-host -> retry-queued-without-affinity`
- `running-on-host -> terminal`
- `waiting-on-host -> running-on-host`
- `waiting-on-host -> retry-queued-with-affinity`
- `waiting-on-host -> terminal`
- `retry-queued-with-affinity -> selecting-host`
- `retry-queued-without-affinity -> selecting-host`
- `dispatch-blocked-no-host -> selecting-host`
- `degraded-host-missing -> selecting-host`
- `degraded-host-missing -> terminal`

### Contract rules

- the orchestrator is the source of truth for host occupancy and retry affinity
- one active remote run may occupy at most one host at a time
- one host may be occupied by at most one active run at a time
- live continuation turns must stay on the already-owned host for the current run
- retry continuity prefers the previous host only when that host is still configured and unoccupied at redispatch time
- breaking retry affinity must be explicit and observable
- "no host available" should block or defer dispatch, not silently fall back to local execution

## Failure-Class Matrix

| Observed condition                                                             | Local facts available                                             | Normalized runtime facts available                               | Expected decision                                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Initial remote dispatch finds an unoccupied eligible host                      | host pool config, no current occupancy on selected host           | issue is ready, no preferred host or preferred host is available | reserve that host, prepare workspace, start run                                                  |
| Retry becomes due and previous host is still configured and free               | retry entry, preferred host, occupancy map                        | prior run recorded remote host affinity                          | redispatch on the same host                                                                      |
| Retry becomes due and previous host is occupied by another run                 | retry entry, preferred host, occupancy map                        | preferred host still valid but unavailable                       | fall back to another eligible host, record broken continuity in status/artifacts                 |
| Retry becomes due and previous host no longer exists in config                 | retry entry, preferred host                                       | host pool no longer contains preferred host                      | clear affinity, mark degraded host-missing posture, select another host if available             |
| Ready remote issue has no free eligible host                                   | occupancy map shows all eligible hosts owned                      | issue is otherwise dispatchable                                  | leave issue queued, publish `dispatch-blocked-no-host` posture, do not mark tracker failure      |
| Healthy inherited remote run already owns host `builder-b` after restart       | lease/execution-owner facts show remote host and active ownership | selected host is already attached to active run                  | adopt existing run and preserve occupancy on `builder-b`                                         |
| Remote startup fails after host reservation but before first useful run result | reserved host, startup error                                      | no durable continuation state yet                                | release host occupancy and schedule retry without stale reservation                              |
| Remote run fails after making progress on host `builder-a` and is retryable    | prior execution-owner/session host                                | preferred host `builder-a` is known                              | queue retry with same-host affinity                                                              |
| Two remote issues compete for one remaining host in the same poll cycle        | host occupancy plus candidate list                                | deterministic host selector inputs                               | dispatch one issue, leave the other blocked with explicit no-host posture                        |
| Global provider rate-limit pressure is active while hosts are otherwise free   | dispatch-pressure snapshot                                        | host occupancy may be free, provider dispatch is globally paused | honor existing provider-pressure pause first; host occupancy remains observable but not decisive |

## Storage / Persistence Contract

- extend retry/runtime-state persistence in memory so queued retries can carry optional preferred-host affinity
- keep durable execution-owner / session snapshots recording the selected remote host and workspace identity as the continuity source of truth for recovered runs
- status snapshots should add a normalized host-occupancy surface rather than forcing operators to infer occupancy by scanning active issue rows
- backward-compatible parsing should remain for older status snapshots that lack host-occupancy fields

## Observability Requirements

- status JSON should publish:
  - configured remote host summary when remote host-pool mode is active
  - active host occupancy entries
  - blocked/no-host posture when dispatch cannot proceed
  - preferred-host continuity state for queued retries where useful
- rendered `status` output and TUI should make it obvious:
  - which issue owns which host
  - when dispatch is blocked because the host pool is full
  - when a retry kept or lost same-host continuity
- issue artifacts and session snapshots should continue to expose the selected host through execution-owner/session metadata for later reports

## Implementation Steps

1. Extend workflow/domain/config types so remote Codex execution can resolve an explicit eligible host pool instead of one preselected `worker_host`.
2. Refactor runtime wiring so the orchestrator selects a host per run and passes that host into workspace preparation and runner session startup.
3. Add a focused host-dispatch runtime-state module under `src/orchestrator/` for occupancy, preferred-host continuity, and no-host posture transitions.
4. Update retry bookkeeping so queued retries retain optional preferred-host affinity without overloading existing retry counters.
5. Update restart adoption / reconciliation paths so recovered remote runs repopulate host occupancy from execution-owner facts.
6. Update status/TUI/issue-artifact projections with normalized host occupancy and continuity context.
7. Expand mocked SSH/Codex test support to simulate more than one worker host and host-specific outcomes.
8. Add unit, integration, and e2e tests for host selection, blocked dispatch, retry continuity, and degraded missing-host cases.
9. Update README and any directly relevant operator/runtime docs to describe host-pool config and degraded no-host behavior.

## Tests And Acceptance Scenarios

### Unit tests

- workflow parsing accepts the new remote host-pool config and rejects unknown host references
- host-dispatch runtime state tracks occupancy, reservation release, and retry affinity explicitly
- retry bookkeeping preserves preferred host without conflating it with failure-attempt counters
- restart recovery restores host occupancy from inherited remote execution-owner facts
- status snapshot parsing/rendering round-trips host occupancy and blocked no-host posture

### Integration tests

- orchestrator dispatches two remote-ready issues onto two different mock hosts when both are free
- a retryable remote failure reuses the same host when it becomes due and that host is still free
- a retryable remote failure falls back cleanly when the preferred host is occupied or removed from config

### End-to-end coverage

- mocked multi-host GitHub bootstrap flow where:
  - issue A runs on host `builder-a`
  - issue B runs on host `builder-b`
  - a retry for issue A keeps `builder-a` continuity when possible
- mocked remote flow where all hosts are occupied and a ready issue stays blocked with an operator-visible no-host posture instead of failing the tracker lifecycle

### Acceptance scenarios

1. A remote Codex run selects one host from a configured pool and publishes that host through status and artifacts.
2. A live continuation turn stays on the original selected host for the duration of the run.
3. A retryable failure prefers the previous host when it is still available and otherwise falls back explicitly to another eligible host.
4. Restart recovery adopts a healthy inherited remote run without double-booking its host.
5. When no remote host is available, Symphony surfaces degraded dispatch posture and waits instead of silently changing execution mode or failing the issue outright.

## Exit Criteria

- remote Codex execution no longer requires one statically preselected host at runner construction time
- host occupancy and retry continuity are represented explicitly in orchestration runtime state
- status surfaces make remote host bottlenecks inspectable
- mocked multi-host remote tests prove host-aware dispatch and retry continuity through the real orchestration flow
- docs explain the host-pool behavior and degraded no-host posture clearly

## Deferred To Later Issues / PRs

- provider-neutral host scheduling across Claude or generic-command runners
- multi-instance host coordination or remote-host leases shared across factories
- remote host health scoring, draining, or balancing heuristics beyond deterministic selection
- tracker comments or labels that expose host posture externally
- report-level host occupancy trend analysis beyond the per-run/session facts already captured
