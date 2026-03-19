# Issue 192 Plan: Queue Priority Contract At The Tracker Boundary

## Status

- plan-ready

## Goal

Define a tracker-neutral queue-priority contract that tracker adapters can populate and the orchestrator can consume without knowing whether the ordering hint came from GitHub Projects, Linear priority fields, or another tracker-native source.

## Scope

- extend the normalized tracker issue contract with optional queue-priority metadata
- add an optional workflow config contract for queue-priority support at the tracker boundary
- define fallback semantics for missing, unset, or unusable tracker priority
- define deterministic tie-break semantics for future queue ordering
- add contract tests and docs that lock in the boundary without implementing adapter-specific transport work
- keep current repos backward-compatible when no queue-priority config is present

## Non-goals

- GitHub Projects transport, parsing, or normalization work
- Linear priority transport or normalization changes beyond preserving the future seam
- broad tracker-adapter refactors unrelated to queue priority
- changing runner, workspace, or retry/reconciliation behavior
- redesigning the TUI, reports, or status payloads beyond any minimal contract additions needed to keep the model coherent
- landing provider-specific queue-ordering policy that depends on raw tracker payloads

## Current Gaps

- `src/domain/issue.ts` exposes no tracker-neutral field for queue-priority metadata, so the orchestrator can only order ready work by incidental tracker list order plus existing deterministic fallback
- `src/tracker/service.ts` returns `RuntimeIssue[]` with no explicit queue-priority contract, which makes later adapter work riskily implicit
- `src/domain/workflow.ts` and `src/config/workflow.ts` have no queue-priority configuration seam for adapters to opt into
- there is no first-class queue-priority comparison contract that future queue-ordering work can call, so later adapter issues would otherwise risk hard-coding tracker details directly into dispatch logic
- current tests cover retry/backoff queue behavior, but there are no contract tests for normalized ready-work ordering hints, absent priority, or config validation
- README / workflow docs do not yet explain how queue priority fits with ready-state eligibility and deterministic fallback ordering

## Decision Notes

- This slice should introduce the contract and deterministic semantics now, but keep tracker transport and normalization deferred to child issues.
- The normalized queue-priority shape should live with the tracker-normalized issue contract, not as raw tracker data hidden inside orchestrator policy.
- The workflow config seam should be optional and tracker-neutral in shape, while still living under tracker-owned configuration so adapters can consume it without creating a second policy source.
- Missing or unusable priority must degrade cleanly to deterministic fallback ordering rather than making the repo unusable.
- The tie-break contract should be explicit now so GitHub and Linear child issues can implement the same ordering surface without reopening orchestrator semantics later.
- This slice should not change the active poll-loop dispatch order yet; it should define the contract and its deterministic comparator semantics in a narrow, testable seam that later ordering work can adopt.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining Symphony-level meaning for queue priority as an ordering hint among already-ready work
  - belongs: documenting fallback and tie-break rules
  - does not belong: GitHub Projects field names, Linear enum ranges, or tracker-specific parsing rules
- Configuration Layer
  - belongs: typed workflow config for optional queue-priority support and boundary validation
  - does not belong: tracker transport calls or hidden defaults inside adapters
- Coordination Layer
  - belongs: defining what future queue-ordering logic may assume about normalized queue-priority metadata and deterministic fallback semantics
  - does not belong: raw GitHub or Linear payload inspection
- Execution Layer
  - belongs: no changes in this slice
  - does not belong: queue-priority configuration or tracker metadata
- Integration Layer
  - belongs: the tracker-facing contract that later adapters must satisfy
  - does not belong: provider-specific transport work in this issue
- Observability Layer
  - belongs: preserving enough normalized metadata and documented semantics for later status/report projection
  - does not belong: a broader operator-surface redesign in this slice

## Architecture Boundaries

### Belongs in this issue

- `src/domain/issue.ts`
  - add the normalized queue-priority shape or adjacent tracker-owned normalized metadata surface
  - keep the shape tracker-neutral and explicit
- `src/domain/workflow.ts`
  - define the typed queue-priority config contract
- `src/config/workflow.ts`
  - parse and validate the optional queue-priority config section
- `src/tracker/service.ts`
  - continue returning tracker-normalized issues through a stable contract that now includes queue-priority metadata
- a small pure comparison helper in a tracker-neutral domain / policy seam
  - define deterministic queue-priority ordering semantics without changing live poll-loop behavior yet
- `README.md` and `WORKFLOW.md`
  - document the contract, fallback posture, and non-goals briefly
- focused unit tests
  - contract tests for config parsing, normalized issue shape, and queue-order semantics

### Does not belong in this issue

- GitHub adapter work that fetches Projects or project item fields
- Linear adapter work that maps Linear `priority` into the normalized queue-priority shape
- mixing tracker transport, normalization, and policy in a single new hot file
- tracker-specific status-surface text or report redesign
- retry queue, continuation loop, reconciliation, lease recovery, or landing-flow changes

## Layering Notes

- `config/workflow`
  - owns parsing and validation of the optional queue-priority config contract
  - does not infer tracker priority from raw issue payloads
- `tracker`
  - owns normalized queue-priority facts on `RuntimeIssue`
  - will later map tracker-native fields into the contract inside adapter boundaries
  - does not force the orchestrator to understand tracker schemas
- `workspace`
  - untouched
  - does not carry ordering metadata
- `runner`
  - untouched
  - does not participate in queue ordering
- `orchestrator`
  - is intentionally unchanged in this slice, except for possible adoption of a shared comparator helper only if it preserves current runtime behavior
  - does not parse raw GitHub / Linear priority data
- `observability`
  - may later project normalized queue-priority facts
  - does not become the source of truth for ordering semantics

## Slice Strategy And PR Seam

This issue should land as one reviewable PR by keeping the slice at the contract boundary:

1. add the normalized queue-priority issue shape
2. add the optional config contract and validation
3. define the queue comparison contract in a pure helper with deterministic fallback
4. document and test the semantics

This remains reviewable because it does not combine:

- GitHub Projects transport work
- Linear normalization work
- tracker policy rewrites unrelated to queue priority
- observability redesign

Deferred child slices can implement GitHub and Linear population of the normalized field without reopening the orchestrator abstraction or config shape.

## Runtime State Model

Not applicable for this slice. The work introduces a tracker-boundary contract and queue-order semantics, but it does not change retries, continuations, reconciliation, leases, or handoff states.

## Failure-Class Matrix

| Observed condition                                                  | Local facts available                          | Normalized tracker facts available                     | Expected behavior                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Queue-priority config is absent                                     | resolved workflow config                        | issue has no queue-priority field or `null`            | accept config; preserve backward-compatible deterministic fallback ordering                               |
| Queue-priority config is present but malformed                      | raw workflow front matter path                  | none                                                   | fail workflow parsing early with a field-specific config error                                            |
| Tracker adapter does not provide queue-priority metadata            | tracker kind, resolved config                   | `queuePriority: null`                                  | issue remains eligible; ordering falls back to deterministic non-priority rules                           |
| Tracker adapter provides an unusable normalized value               | normalized field present but invalid            | malformed rank / missing required normalized field      | fail at adapter normalization boundary or coerce to documented null/fallback behavior; do not leak raw data upward |
| Two ready issues have different normalized ranks                    | candidate issue numbers                         | comparable normalized ranks                            | lower normalized rank wins                                                                                |
| Two ready issues have the same normalized rank                      | candidate issue numbers                         | identical normalized ranks                             | use the documented deterministic tie-break rule only                                                      |
| One issue has normalized priority and another does not              | candidate issue numbers                         | one `queuePriority`, one `null`                        | the prioritized issue sorts ahead; the unprioritized issue still remains eligible                         |
| All ready issues have no normalized priority                        | candidate issue numbers                         | all `queuePriority: null`                              | preserve deterministic fallback ordering with no tracker-specific behavior required                       |

## Storage / Persistence Contract

- no new durable local storage is introduced
- queue priority remains tracker-normalized in-memory issue metadata
- workflow config remains the repository-owned policy source for enabling and shaping adapter usage
- existing local status and artifact persistence remain unchanged unless a minimal normalized field projection is required later

## Observability Requirements

- the normalized issue contract should be sufficient for later status/report projection of queue priority without exposing tracker-native schemas
- config errors must fail clearly at parse time with field-specific messages
- tests should lock in the documented fallback semantics so operator-facing surfaces can rely on a stable ordering contract later

## Implementation Steps

1. Define a tracker-neutral `queuePriority` shape in the normalized issue domain, including the minimal facts needed for ordering and future observability.
2. Define a typed optional queue-priority config contract in `src/domain/workflow.ts`.
3. Parse and validate that config in `src/config/workflow.ts`, keeping absent config fully backward-compatible.
4. Update tracker service call sites and test fixtures so normalized issues can carry `queuePriority: null` without provider-specific implementation work.
5. Add a pure queue-priority comparison helper that expresses:
   - lower normalized rank wins
   - populated priority sorts ahead of missing priority
   - equal or missing priority falls back to issue number ascending
6. Add unit coverage for:
   - valid and invalid queue-priority config
   - absent config / absent priority fallback
   - lower-rank-wins semantics
   - deterministic tie-break behavior
7. Update README / workflow documentation with a concise explanation of the contract and what remains deferred.
8. Run repo checks and local self-review before PR creation.

## Tests And Acceptance Scenarios

### Unit

- workflow parsing accepts omitted queue-priority config
- workflow parsing rejects malformed queue-priority config with field-specific errors
- normalized runtime issues can represent `queuePriority: null` and a populated queue-priority object without tracker-specific schema fields
- queue ordering prefers lower normalized rank
- queue ordering falls back deterministically when one or both issues have no normalized priority
- queue ordering uses the documented tie-break rule when ranks are equal

### Integration

- existing tracker adapters still return ready issues successfully when no queue-priority population exists yet
- queue-priority comparator tests prove the contract consumes only normalized issue metadata, not adapter internals

### Repo Gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- local self-review when a reliable review command is available

## Acceptance Scenarios

1. Given a repo with no queue-priority config, Symphony still loads the workflow and orders ready work deterministically without tracker-specific priority data.
2. Given two normalized ready issues with different queue-priority ranks, the lower rank sorts first according to the shared comparison helper.
3. Given two ready issues with equal ranks, Symphony applies one documented deterministic tie-break rule rather than relying on incidental tracker list order.
4. Given one ready issue with normalized priority and one without, the prioritized issue sorts ahead while the unprioritized issue remains eligible.
5. Given malformed queue-priority config, workflow loading fails at the config boundary with a clear field-specific error.
6. Given current GitHub and Linear adapters that do not yet populate the normalized queue-priority field, existing ready-issue fetches remain backward-compatible.

## Exit Criteria

- the normalized tracker issue contract can represent queue priority without embedding GitHub or Linear schema details
- workflow config exposes an optional validated queue-priority seam
- queue-priority semantics are explicit, deterministic, and covered by tests without requiring provider-specific transport work or a live dispatch change
- current adapters remain backward-compatible until child transport/normalization slices land
- the PR stays within one reviewable seam and clearly defers provider-specific population work

## Deferred To Later Issues Or PRs

- GitHub Projects transport and normalization for queue-priority population
- Linear priority mapping into the normalized contract
- richer status/report projection of queue-priority metadata
- wiring the active poll loop to use the new queue-priority comparator once adapter population slices land
- any repo-specific policy beyond the normalized contract and deterministic fallback rules
- any further dispatch heuristics that combine priority with other readiness or pressure signals

## Revision Log

- 2026-03-19: Initial draft created for issue #192.
- 2026-03-19: Narrowed the slice to the contract/config/comparator seam and marked the plan `plan-ready`.
