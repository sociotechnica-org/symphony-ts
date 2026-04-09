# Issue 337 Plan: Promote Dependency Relationships Into The Normalized Tracker Contract

## Status

- plan-ready

## Goal

Promote dependency relationships into the stable internal issue contract so tracker adapters normalize blocker facts once at the boundary and the rest of the runtime can consume one tracker-neutral `RuntimeIssue` shape.

The intended outcome of this slice is:

1. `RuntimeIssue` carries normalized blocker references in a durable, tracker-neutral field.
2. GitHub and Linear populate that same field at normalization time instead of keeping dependency facts only in provider-specific snapshots or claim-time probes.
3. GitHub blocked-relationship dispatch enforcement from `#329` continues to work, but it derives its decision from normalized `RuntimeIssue.blockedBy` facts instead of a special tracker-only side channel.
4. the orchestrator, prompt/tool context, and future Beads work can rely on one internal dependency contract without learning provider-native terminology or payload shapes.

## Scope

This slice covers:

1. extending the normalized runtime issue contract with a stable blocker-reference field
2. defining a small tracker-neutral blocker-reference type that current trackers can populate consistently
3. updating GitHub transport and normalization so `fetchIssuesByLabel()` and `getIssue()` return `RuntimeIssue` objects with normalized blockers
4. reconciling Linear normalization so `runtimeIssue.blockedBy` uses the same contract already carried in the adapter snapshot
5. changing GitHub ready filtering and claim-time blocked checks to consume normalized dependency facts from `RuntimeIssue`
6. updating the supporting tests, fixtures, and docs needed for the new contract

## Non-Goals

This slice does not include:

1. a DAG scheduler or broader orchestrator-native dependency planning
2. redesigning operator release-state or ready-promotion policy around issue dependencies
3. cross-repository dependency semantics or portfolio planning
4. tracker-authored dependency mutation APIs
5. expanding prompt context, status surfaces, or TUI rendering with dependency details beyond what is required to keep the contract coherent and testable
6. Beads adapter implementation work beyond defining a contract Beads can target later

## Current Gaps

Today dependency facts are not part of the shared runtime contract:

1. [`src/domain/issue.ts`](../../../src/domain/issue.ts) carries labels, timestamps, and queue priority, but no normalized blocker references.
2. GitHub blocked-relationship enforcement lives in [`src/tracker/github.ts`](../../../src/tracker/github.ts) as a provider-specific readiness gate powered by a dedicated blocked-status query path in [`src/tracker/github-client.ts`](../../../src/tracker/github-client.ts).
3. Linear already normalizes blocker relations in [`src/tracker/linear-normalize.ts`](../../../src/tracker/linear-normalize.ts), but those facts remain in `LinearIssueSnapshot.blockedBy` instead of the shared `runtimeIssue`.
4. downstream consumers such as the orchestrator and tracker tool context consume `RuntimeIssue`, so they cannot reason over dependencies without provider-specific escape hatches.
5. future Beads work would otherwise repeat the same pattern: provider-specific dependency logic first, shared runtime contract later.

## Decision Notes

1. Use one required `RuntimeIssue.blockedBy` array rather than an optional field. Empty-array semantics are simpler, avoid consumer nullability churn, and make the contract more durable.
2. Keep the blocker-reference payload small. The first slice should carry identity and explanatory facts needed for dispatch and future observability, not every provider-native relationship detail.
3. Preserve transport, normalization, and policy boundaries. GitHub GraphQL or REST schema details stay inside the client; the tracker consumes normalized `RuntimeIssue` objects.
4. Preserve the existing `tracker.respect_blocked_relationships` workflow toggle. This issue promotes the dependency fact into the contract; it does not change the repo-owned choice about whether GitHub dispatch should enforce blockers.
5. Keep the PR on one reviewable seam: domain contract, GitHub normalization, Linear normalization alignment, and the small policy change needed for GitHub dispatch to read normalized data.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses [`docs/architecture.md`](../../architecture.md).

### Policy Layer

Belongs here:

1. the rule that dependency relationships are part of the normalized internal issue contract
2. the rule that GitHub blocked dispatch enforcement consumes normalized blocker facts when enabled
3. the rule that current scope stops at shared facts, not full dependency scheduling

Does not belong here:

1. provider-specific GraphQL field names
2. tracker transport pagination and request wiring
3. release-state heuristics or orchestrator retry logic

### Configuration Layer

Belongs here:

1. preserving the existing `respectBlockedRelationships` toggle as the repo-owned GitHub policy switch
2. any type updates required because `RuntimeIssue` is part of workflow-facing prompt/tool contracts

Does not belong here:

1. tracker-side dependency fetching
2. dependency graph persistence
3. provider-specific fallback logic

### Coordination Layer

Belongs here:

1. no orchestrator state-machine changes in this slice
2. continued orchestrator reliance on the normalized issue contract returned by trackers

Does not belong here:

1. parsing provider-native dependency payloads
2. special GitHub-only blocked-status branches
3. release promotion redesign

### Execution Layer

Belongs here:

1. no workspace or runner changes in this slice

Does not belong here:

1. runner-owned dependency gating
2. workspace-owned dependency metadata shaping

### Integration Layer

Belongs here:

1. the new shared blocker-reference contract in the domain layer as consumed by trackers
2. GitHub transport support for fetching dependency references
3. GitHub and Linear normalization that populate `RuntimeIssue.blockedBy`
4. GitHub tracker policy deriving blocked dispatch decisions from normalized issue data

Does not belong here:

1. orchestrator scheduling strategies
2. operator release-state evaluation
3. UI-specific formatting of dependency details

### Observability Layer

Belongs here:

1. structured logs that continue to explain why GitHub ready work was filtered or claim-rejected
2. test evidence that the normalized blocker contract is visible at tracker boundaries

Does not belong here:

1. tracker mutations during status rendering
2. a new dependency dashboard in the same PR

## Architecture Boundaries

### [`src/domain/issue.ts`](../../../src/domain/issue.ts)

Owns:

1. the stable shared blocker-reference type
2. the `RuntimeIssue.blockedBy` contract

Does not own:

1. provider-specific dependency parsing
2. dispatch policy
3. release-state semantics

### [`src/tracker/github-client.ts`](../../../src/tracker/github-client.ts)

Owns:

1. GitHub transport for reading blocker references and any summary facts needed to hydrate normalized issues
2. converting provider-native dependency payloads into domain-aligned blocker references before they leave the client
3. enriching `getIssue()` and `fetchIssuesByLabel()` results with normalized blockers

Does not own:

1. ready-label policy
2. workflow toggle evaluation
3. orchestrator coordination decisions

### [`src/tracker/github.ts`](../../../src/tracker/github.ts)

Owns:

1. deciding whether blocked-relationship enforcement is active
2. filtering or claim-rejecting GitHub issues based on `RuntimeIssue.blockedBy`
3. structured logs for filtered or rejected blocked work

Does not own:

1. raw GitHub schema handling
2. the blocker-reference domain type
3. tracker-neutral scheduling strategy

### [`src/tracker/linear-normalize.ts`](../../../src/tracker/linear-normalize.ts) and [`src/tracker/linear.ts`](../../../src/tracker/linear.ts)

Own:

1. mapping Linear inverse relations into the shared blocker-reference shape
2. keeping `LinearIssueSnapshot` and `runtimeIssue` aligned on dependency facts

Do not own:

1. GitHub dependency policy
2. orchestrator dispatch ordering
3. release-state metadata

### Prompt/Tool/Test Consumers

Relevant consumers include [`src/tracker/prompt-context.ts`](../../../src/tracker/prompt-context.ts), [`src/tracker/tool-service.ts`](../../../src/tracker/tool-service.ts), and runtime/test fixtures that construct `RuntimeIssue`.

They own:

1. compiling against the expanded contract
2. defaulting non-blocked fixtures to `blockedBy: []`

They do not own:

1. dependency normalization logic
2. provider-specific gating behavior

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one seam:

1. extend the runtime issue contract with normalized blockers
2. update GitHub and Linear normalization to populate that contract
3. update GitHub blocked dispatch enforcement to read normalized blockers
4. refresh tests and docs for the new contract

Deferred from this PR:

1. orchestrator-native dependency scheduling
2. operator release-state or ready-promotion redesign around issue blockers
3. richer prompt/status/TUI dependency surfaces
4. Beads adapter ingestion

Why this seam is reviewable:

1. it moves an existing GitHub-only fact into the shared contract without broad orchestrator churn
2. it aligns Linear with the same shared model in the same patch, preventing two parallel contracts from surviving
3. it keeps transport, normalization, and policy changes localized to the tracker boundary and domain contract

## Normalized Dependency Contract

Introduce a shared blocker-reference type in the runtime issue model. The exact identifier names can follow local TypeScript conventions, but the contract should have this shape:

1. `RuntimeIssue.blockedBy: readonly RuntimeIssueBlocker[]`
2. each blocker reference should include:
   - blocker `id` when available
   - blocker `identifier` when available
   - blocker `title` when available
   - blocker `state` when available

Contract rules:

1. `blockedBy` is always present and defaults to `[]`
2. trackers normalize external dependency payloads into this shape at the boundary
3. downstream policy reads the normalized field and does not parse provider-native payloads
4. this slice does not add directionality beyond `blockedBy`; future work can extend the graph only if a new use case requires it

Storage/persistence contract:

1. blocker references are transient tracker facts returned on issue reads
2. this slice does not persist dependency graphs in local state artifacts
3. any future durable dependency cache should be a separate issue with its own contract and failure model

## Tracker Dependency Readiness Model

This issue does not change the orchestrator runtime state machine, but it does define the normalized issue-dependency readiness states that tracker policy will consume.

### State Subject

One `RuntimeIssue` returned by a tracker.

### States

1. `unblocked`
   - `blockedBy.length === 0`
2. `blocked`
   - `blockedBy.length > 0`
3. `dispatch-blocked`
   - tracker policy refuses ready dispatch because blocked enforcement is active and the normalized issue is blocked
4. `dispatch-eligible`
   - tracker policy may dispatch because labels/state are eligible and either the issue is unblocked or blocked enforcement is disabled

### Allowed Transitions

1. `unblocked -> blocked`
2. `blocked -> unblocked`
3. `blocked -> dispatch-blocked`
4. `unblocked -> dispatch-eligible`
5. `blocked -> dispatch-eligible` when policy intentionally disables blocked enforcement

### Contract Rules

1. the dependency fact is normalized regardless of whether GitHub enforcement is enabled
2. policy may choose whether to act on blockers, but consumers should not need new provider-specific transport calls to inspect them
3. claim-time rechecks still matter for GitHub because dependency state can change between ready reads and claim attempts

## Failure-Class Matrix

| Observed condition                                                                           | Local facts available              | Normalized tracker facts available            | Expected decision                                                                    |
| -------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| GitHub issue has no blockers                                                                 | ready label present                | `blockedBy = []`                              | keep existing ready/claim path                                                       |
| GitHub issue has one or more blockers and enforcement is enabled                             | ready label present                | `blockedBy.length > 0`                        | filter from ready reads and reject claim attempts                                    |
| GitHub issue has blockers and enforcement is disabled                                        | ready label present                | `blockedBy.length > 0`                        | return the issue normally; policy remains label-only                                 |
| GitHub ready read saw no blockers, but a later claim re-read sees blockers                   | stale ready read, fresh claim read | old `[]`, fresh non-empty `blockedBy`         | `claimIssue()` returns `null` without mutating labels                                |
| GitHub dependency transport is unavailable while reading an issue that must hydrate blockers | no safe fallback                   | no trustworthy `blockedBy` facts              | fail the tracker read clearly rather than silently inventing an empty dependency set |
| Linear issue has no inverse blocker relations                                                | issue snapshot available           | `blockedBy = []`                              | preserve current readiness behavior                                                  |
| Linear issue has inverse blocker relations                                                   | issue snapshot available           | normalized blocker refs from Linear relations | expose the same contract in `runtimeIssue` with no orchestrator changes              |

## Observability Requirements

1. keep the existing structured logs for filtered blocked GitHub ready issues and rejected claims
2. adjust any log context that currently depends on blocked-summary-only facts so it can derive from normalized blocker refs without losing operator value
3. keep tests explicit about whether blocked decisions came from normalized issue data rather than provider-only probes

## Implementation Steps

1. Extend [`src/domain/issue.ts`](../../../src/domain/issue.ts) with a shared blocker-reference type and required `blockedBy` field on `RuntimeIssue`.
2. Update all local `RuntimeIssue` test builders and fixtures to default `blockedBy` to `[]`.
3. Refactor GitHub dependency transport in [`src/tracker/github-client.ts`](../../../src/tracker/github-client.ts) so the client can fetch blocker references, not just blocker counts.
4. Update GitHub issue normalization paths so `getIssue()` and `fetchIssuesByLabel()` return `RuntimeIssue` objects with populated `blockedBy`.
5. Derive GitHub blocked-status policy in [`src/tracker/github.ts`](../../../src/tracker/github.ts) from normalized issue data during ready reads and claim-time rechecks.
6. Reconcile Linear normalization so `runtimeIssue.blockedBy` is populated from the same normalized relation facts already parsed in [`src/tracker/linear-normalize.ts`](../../../src/tracker/linear-normalize.ts).
7. Remove or collapse any now-redundant GitHub-only blocked-status helper types or methods if the normalized issue contract makes them unnecessary.
8. Update docs and contract-focused tests to describe the normalized blocker field and the continued meaning of `respectBlockedRelationships`.

## Tests And Acceptance Scenarios

### Unit Tests

1. `RuntimeIssue` fixtures/builders compile with required `blockedBy: []` defaults.
2. GitHub dependency normalization turns provider responses into shared blocker references with stable field values.
3. GitHub tracker ready filtering derives blocked decisions from normalized issue data.
4. GitHub claim-time rechecks reject a newly blocked issue using the normalized contract.
5. Linear normalization populates `runtimeIssue.blockedBy` from inverse relations and preserves `[]` when no blockers exist.

### Integration Tests

1. GitHub `fetchReadyIssues()` returns ready issues with normalized blockers on unblocked reads.
2. GitHub blocked ready issues are filtered when enforcement is enabled and still surfaced when enforcement is disabled.
3. GitHub `getIssue()` returns normalized blocker references for blocked issues.
4. GitHub `claimIssue()` returns `null` when the issue becomes blocked between fetch and claim.
5. Linear tracker reads expose the same `RuntimeIssue.blockedBy` contract as GitHub for analogous cases.

### Acceptance Scenarios

1. GitHub blocked issue, enforcement enabled:
   - the tracker returns normalized blocker refs on issue reads
   - ready dispatch is refused because `RuntimeIssue.blockedBy` is non-empty
2. GitHub blocked issue, enforcement disabled:
   - the tracker still returns normalized blocker refs
   - dispatch remains label-driven because the workflow policy switch is off
3. GitHub claim race:
   - an issue is initially unblocked, becomes blocked before claim, and the later claim is rejected without label mutation
4. Linear issue with blockers:
   - the returned `RuntimeIssue` exposes the same blocker-reference contract as GitHub
5. Non-blocked issue on either tracker:
   - `blockedBy` is present as `[]`, not omitted or `null`

## Exit Criteria

1. the runtime issue contract includes a shared normalized blocker-reference field
2. GitHub and Linear both populate that field at normalization time
3. GitHub blocked dispatch enforcement consumes normalized dependency facts instead of a provider-only blocked-status branch
4. transport, normalization, and policy remain separated in tracker code
5. tests cover contract defaults, GitHub normalization, Linear normalization, and GitHub fetch/claim gating behavior
6. docs and/or contract comments make the new field and its empty-array behavior explicit

## Deferred To Later Issues Or PRs

1. dependency-aware orchestrator scheduling
2. dependency-aware operator release advancement based directly on tracker-normalized issue graphs
3. richer observability or prompt projection of blocker details
4. Beads adapter implementation
5. mutation APIs or synchronization tooling for dependency relationships
