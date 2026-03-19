# Issue 188 Plan: Add Host-Aware Dispatch, Retry Continuity, And Mocked Remote End-To-End Coverage

## Status

- plan-ready

## Goal

Add a coordination-owned host dispatch seam for remote execution so Symphony can:

- choose among configured worker hosts explicitly,
- preserve same-host continuity for continuation turns and eligible retries,
- surface host occupancy and host pressure in operator-visible status,
- and prove the real orchestration flow with mocked remote end-to-end coverage.

This slice should build directly on `#182`, `#183`, and `#187` without widening the change into tracker policy, generic hosted-task support, or runner-transport redesign.

## Scope

- generalize remote execution config from one fixed SSH worker host to an explicit set of eligible remote worker hosts for Codex remote execution
- add a coordination-owned host dispatch runtime-state module that tracks:
  - configured host capacity
  - current host occupancy
  - last successful host assignment per issue/run continuity key
  - host-level pressure/degraded posture
- preserve the current same-host continuation rule for live sessions and extend continuity rules to retries and reruns where the previous host remains eligible
- keep remote workspace preparation and Codex SSH execution pinned to the selected host for a run attempt
- project host occupancy, continuity decisions, and degraded host pressure through status snapshots, TUI surfaces, and issue artifacts where needed
- add unit/integration coverage for host selection and continuity decisions plus mocked remote-host end-to-end coverage that exercises the real orchestrator flow across retries
- document the host-selection and degraded-host behavior in README and directly relevant runtime docs

## Non-goals

- tracker transport, tracker normalization, or tracker lifecycle-policy changes
- a generic multi-provider remote scheduling framework beyond the existing Codex SSH path
- cross-factory distributed host leasing or coordination across multiple Symphony instances
- new remote execution transports beyond SSH stdio
- redesigning the retry budget/backoff algorithm from `#164`
- changing continuation-turn semantics for already-live sessions beyond preserving their selected host
- full remote process recovery or host failover after a live remote session is already in progress

## Current Gaps

- `src/domain/workflow.ts` and `src/config/workflow.ts` let Codex remote execution point to one explicit `workerHost`; there is no typed notion of an eligible host set or host selection policy.
- `src/workspace/remote-ssh.ts` and `src/runner/codex.ts` already support one concrete remote host, but host selection is effectively decided in config before orchestration begins.
- `src/orchestrator/service.ts` tracks overall concurrency and provider dispatch pressure, but it has no host-aware occupancy map, host continuity memory, or host-pressure projection.
- Current retry state tracks due retries and transient provider pressure, but it does not preserve or consult remote-host continuity when a run is retried after failure.
- Status and TUI surfaces can render remote execution facts for one running issue, but they do not summarize per-host occupancy, availability, or continuity posture.
- `tests/e2e/bootstrap-factory.test.ts` proves one mocked remote SSH path, but it does not exercise host selection, host reuse across retries, or degraded cases where one host is unavailable and another remains eligible.

## Decision Notes

- Keep host selection in the coordination layer. Workflow/config may declare eligible hosts and static capacity, but the orchestrator owns run-time host assignment and continuity decisions.
- Keep workspace and runner layers host-consumptive, not host-selective. They should receive a chosen host and prepared workspace target; they should not decide which host wins.
- Preserve a narrow seam by adding one focused runtime-state module for host dispatch instead of spreading host maps and continuity flags through `service.ts`.
- Treat host continuity as a policy over normalized facts:
  - same live session must remain on its existing host
  - a retry should prefer the previous host when that host is still eligible and not explicitly degraded
  - a fresh dispatch may choose any eligible host under the configured policy
- Model host pressure separately from global provider dispatch pressure. A single degraded worker host should not necessarily block all remote dispatch if another configured host remains healthy.
- Keep the current PR review surface centered on coordination, config wiring, execution consumption, and observability projection for the existing Codex SSH path only.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repository-owned rule that remote host selection and retry continuity are explicit coordination policy, not hidden in runner commands or tracker adapters
  - belongs: the rule that continuation turns stay on the current host and eligible retries prefer the previous host before falling back
  - does not belong: SSH subprocess arguments, tracker comments, or TUI rendering details
- Configuration Layer
  - belongs: typed workflow config for eligible worker hosts, any per-host dispatch-capacity facts, and validation that a remote execution profile references only declared hosts
  - does not belong: live occupancy, retry continuity memory, or degraded host state
- Coordination Layer
  - belongs: host selection policy, occupancy tracking, continuity memory, host-pressure state, and retry-time host reassignment decisions
  - does not belong: SSH command composition, remote git commands, or tracker lifecycle mutation
- Execution Layer
  - belongs: preparing a workspace on the chosen host, starting Codex over SSH on that host, and preserving the selected host within the run session and execution owner facts
  - does not belong: deciding which eligible host to choose or how retries should rebalance
- Integration Layer
  - belongs: unchanged tracker integration; tracker code continues to consume normalized issue and handoff state only
  - does not belong: host scheduling, occupancy, or retry continuity policy
- Observability Layer
  - belongs: publishing per-host occupancy/availability snapshots, continuity decisions, and selected-host facts for active/retrying issues
  - does not belong: recomputing host policy independently of coordination state

## Architecture Boundaries

### `src/config/`

Owns:

- parsing and validating remote-worker host pools and any host-capacity settings
- resolving the default host-selection inputs that the orchestrator will consume

Does not own:

- choosing a host for a specific run
- remembering prior host assignments across retries
- host-pressure transitions

### `src/orchestrator/`

Owns:

- a focused host-dispatch runtime-state module
- host selection and release transitions
- continuity memory for retries and reruns
- decisions about when a degraded host should be skipped or when no eligible host exists

Does not own:

- SSH transport internals
- remote workspace bootstrap commands
- tracker-specific fallback policy

### `src/workspace/` and `src/runner/`

Own:

- consuming the selected host through a normalized prepared workspace / runner config seam
- preserving one selected host for the lifetime of a live remote run

Do not own:

- choosing among multiple hosts
- continuity rules for retries
- operator-facing host occupancy summaries

### `src/observability/`

Owns:

- serializing and rendering host occupancy/pressure snapshots and selected-host facts
- making degraded/no-capacity cases inspectable in status and test artifacts

Does not own:

- authoritative host assignment state
- selection or continuity rules

## Layering Notes

- `config/workflow`
  - resolves the remote host pool and static capacity
  - does not hide run-time host assignment in a preselected single-host field
- `tracker`
  - remains unchanged
  - does not learn about remote hostnames or occupancy
- `workspace`
  - prepares workspaces on a chosen host
  - does not decide dispatch policy
- `runner`
  - runs Codex against the chosen host/workspace target
  - does not perform host fallback or rebalance
- `orchestrator`
  - owns host assignment, continuity, retry reuse, and degraded-host decisions
  - does not parse SSH protocol details
- `observability`
  - projects host state clearly for operators
  - does not infer host policy from raw runner events alone

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one coordination-centered seam:

1. add typed config for an eligible remote host set and static per-host dispatch capacity
2. add a focused host-dispatch runtime-state module with explicit transitions
3. adapt workspace/runner orchestration wiring so each run attempt receives one selected host and retries can prefer the prior host when appropriate
4. widen status/TUI/artifact projection just enough to expose host occupancy and degraded-host posture
5. add mocked remote end-to-end coverage for host selection and retry continuity

Deferred from this PR:

- generic remote scheduling for non-Codex runners
- distributed host leasing across multiple factory instances
- automatic mid-run migration from one live remote session to another host
- long-term host health persistence across process restarts
- tracker-surface changes for host occupancy beyond existing normalized lifecycle/status facts

Why this seam is reviewable:

- it stays centered on one stateful runtime concept: host-aware remote dispatch
- it builds on the existing remote SSH execution seam instead of redesigning it
- it avoids mixing tracker boundary work with coordination-state changes
- it keeps the mocked end-to-end proof attached to the same seam instead of bundling unrelated factory features

## Runtime State Machine

This issue changes orchestration behavior for retries, remote dispatch, and degraded-host handling, so it requires an explicit coordination-owned state machine.

### State variables

- `eligibleHosts`
  - validated configured worker hosts that may run the issue
- `hostCapacity`
  - static dispatch slots per host for this factory instance
- `hostOccupancy`
  - active issue/run assignments currently consuming capacity on each host
- `continuityHostByIssue`
  - preferred prior host for a retriable issue once a remote attempt has started successfully
- `hostPressure`
  - per-host degraded or blocked-until posture when host-specific dispatch failure is observed
- `assignment`
  - selected host for the current run attempt, if any

### Per-host states

1. `available`
   - host is eligible, not pressure-blocked, and has free capacity
2. `occupied`
   - host has at least one active assignment and may still have remaining free capacity
3. `saturated`
   - host is eligible but has no free capacity
4. `degraded`
   - host is temporarily blocked from new dispatch because a host-specific failure window is active
5. `unavailable`
   - host is configured but cannot satisfy dispatch because validation or startup facts make it unusable for the current run

### Per-issue assignment states

1. `unassigned`
   - no host selected for the next attempt yet
2. `assigned`
   - a host has been selected and capacity reserved for workspace preparation / run start
3. `running`
   - one live remote attempt is executing on the assigned host
4. `continuity-held`
   - the run finished in a retryable state and the prior host remains the preferred retry host
5. `released`
   - host occupancy has been released and no continuity preference remains
6. `fallback-eligible`
   - the prior host is unavailable or degraded, so retry may choose another eligible host

### Allowed transitions

- `unassigned -> assigned`
- `assigned -> running`
- `assigned -> fallback-eligible`
  - selected host failed before a live attempt was established
- `running -> continuity-held`
  - run failed retryably after host assignment should remain the first retry preference
- `running -> released`
  - run completed terminally or no continuity should survive
- `continuity-held -> assigned`
  - retry reuses the preferred host
- `continuity-held -> fallback-eligible`
  - preferred host is no longer eligible for immediate reuse
- `fallback-eligible -> assigned`
  - another host wins selection
- `fallback-eligible -> released`
  - retry is exhausted or the issue reaches a terminal state

### Contract rules

- a live continuation turn never changes host
- host occupancy is reserved before remote workspace preparation starts and released exactly once when the attempt no longer owns the host slot
- retry continuity records only a preferred host, not a guarantee; degraded or saturated hosts may force fallback
- host-specific degraded posture applies only to that host unless coordination derives a global provider-pressure decision separately
- if no eligible host is currently dispatchable, the issue remains queued/retrying rather than forcing a tracker-level failure immediately

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized coordination facts available | Expected decision |
| --- | --- | --- | --- |
| Fresh remote issue, two hosts available, no continuity history | configured host pool | host A and B available, no preferred host | select one host by explicit host-dispatch policy and reserve capacity |
| Retryable failure after running on host A, host A still available | prior execution owner, retry state | preferred host A, host A available | retry on host A and preserve continuity |
| Retryable failure after running on host A, host A saturated but host B available | prior host A, occupancy map | preferred host A, host A saturated, host B available | fall back to host B if policy allows waiting would be worse than reassignment |
| Retryable failure after running on host A, host A degraded, host B available | host-specific failure classification | preferred host A, host A blocked, host B available | mark host A degraded and retry on host B |
| Host A SSH/workspace prep fails before live run starts, host B available | workspace/runner start error | selected host A, no live session, host B available | release A occupancy, note host pressure if applicable, retry selection on B in the same dispatch cycle or next retry path |
| Host A degraded, host B degraded, no host available | host-specific failures | all eligible hosts blocked or unavailable | do not dispatch; surface no-capacity/degraded posture and keep retry/backoff path inspectable |
| Live run on host A enters continuation turn loop | live session facts | assignment running on host A | keep continuation turns on host A regardless of host B availability |
| Terminal success or non-retryable failure on host A | final run result | assignment on host A, issue terminal | release occupancy and clear continuity preference |

## Storage / Persistence Contract

- host dispatch state remains local coordination state for this slice; no new tracker persistence is introduced
- active execution-owner and status snapshots should carry the selected workspace host and enough normalized facts to explain continuity decisions after restart-free observation
- issue artifacts may record selected-host and fallback/degraded observations, but they should not become the source of truth for occupancy accounting
- restart persistence for host continuity is deferred; this slice may rebuild host occupancy from active in-memory runs and existing execution-owner facts only

## Observability Requirements

- status snapshots and TUI should surface:
  - per-host active occupancy and free capacity
  - degraded/blocked hosts with resume timing when applicable
  - selected host for each active remote issue
  - continuity preference for queued retries when useful
- issue artifacts should include host-selection and host-fallback observations for remote runs
- operator-visible summaries must distinguish:
  - global provider dispatch pressure
  - per-host pressure or no-capacity posture
- degraded cases where no host can accept work must be explicit and testable, not hidden behind a generic retry message

## Implementation Steps

1. Refine workflow/domain config so Codex remote execution can reference an eligible host set and optional static per-host dispatch capacity while remaining backward-compatible with the current single-host config where practical.
2. Add a focused `src/orchestrator/host-dispatch-state.ts` (or equivalent) that owns host inventory, occupancy, continuity preference, selection, release, and degraded-host transitions.
3. Update orchestrator dispatch/retry flow to:
   - choose a host before remote workspace preparation,
   - reserve and release occupancy explicitly,
   - retain preferred-host continuity across eligible retries,
   - and fall back cleanly when the preferred host is unavailable.
4. Adapt workspace/runner wiring so one chosen host flows through remote workspace preparation, run-session creation, execution-owner updates, and retry follow-up without re-selecting host inside execution code.
5. Extend status-state, status snapshot, TUI projection, and issue-artifact observations to publish host occupancy and degraded-host posture.
6. Add focused unit tests for host-dispatch state transitions, orchestrator retry continuity behavior, and observability projections.
7. Extend mocked remote integration/end-to-end coverage to exercise:
   - host selection across multiple remote hosts,
   - retry continuity on the same host,
   - and fallback or no-capacity degraded cases.
8. Update README and directly relevant docs to describe eligible worker hosts, continuity rules, and degraded-host behavior.

## Tests And Acceptance Scenarios

### Unit / focused tests

- workflow parsing accepts a remote host pool and rejects remote execution profiles that reference undefined hosts
- host-dispatch state selects among eligible hosts, respects capacity, and tracks release correctly
- host-dispatch state prefers the previous host for retry continuity when it remains available
- host-dispatch state falls back when the preferred host is degraded or unavailable
- orchestrator tests prove that live continuation turns never switch hosts and retry attempts preserve host continuity when eligible
- status and artifact tests round-trip host occupancy / degraded-host projection

### Integration tests

- remote workspace/runner wiring receives the chosen host from coordination rather than selecting a host internally
- host-specific start failure marks only that host degraded and leaves other hosts eligible

### End-to-end tests

- mocked remote GitHub bootstrap flow dispatches one issue to host A, retries on host A after a retryable remote failure, and succeeds on the continued host
- mocked remote GitHub bootstrap flow degrades host A, dispatches the retry to host B, and leaves an inspectable status/history trail showing the fallback
- mocked remote GitHub bootstrap flow with all eligible hosts blocked surfaces a degraded/no-capacity posture without silently pretending the issue ran

### Acceptance scenarios

1. A new remote Codex run with two configured worker hosts chooses one host explicitly and publishes that choice through status/artifacts.
2. A retryable remote failure preserves same-host preference and reuses the previous host when that host remains dispatchable.
3. A degraded or unavailable preferred host causes a clear fallback to another eligible host without mixing host-selection policy into workspace or runner code.
4. When no eligible host can accept the work, Symphony surfaces host-pressure/no-capacity posture clearly and keeps the issue in a recoverable retry path.
5. Existing single-host remote execution continues to work without behavior regression.

## Exit Criteria

- remote host selection is explicit and coordination-owned
- retry continuity preserves same-host preference when appropriate
- host occupancy and degraded-host posture are published through status surfaces and tests
- mocked remote end-to-end coverage proves the real orchestration path for host selection, retry continuity, and degraded fallback
- local, single-host remote behavior remains backward-compatible or has a clearly documented migration path

## Deferred To Later Issues Or PRs

- durable host occupancy / continuity recovery across full process restarts
- cross-factory or distributed worker-host leasing
- remote host scheduling for runners other than Codex SSH
- richer policy knobs such as weighted host selection or per-host capability matching
- automatic live-session migration or recovery on another host after a remote run is already mid-flight
