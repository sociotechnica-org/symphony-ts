# Issue 281 Plan: Operator Halts Release Advancement On Prerequisite Failure

## Status

- plan-ready

## Goal

Give the operator a deterministic, repo-owned rule for dependency-driven releases: when a prerequisite ticket in the selected release fails, the operator must stop advancing downstream tickets and persist that blocked release posture in canonical operator state instead of relying on scratchpad prose or memory.

The intended outcome of this slice is:

1. the operator wake-up workflow checks release dependency state before ordinary release advancement work
2. a failed prerequisite blocks downstream promotion/landing decisions for that release
3. the blocked release posture is stored in typed operator-local state and surfaced in operator status/notebook artifacts
4. tests cover the regression where a failed prerequisite previously allowed later tickets to keep moving

## Scope

This slice covers:

1. a typed operator-owned release/dependency state contract under the selected instance state root
2. wake-up policy updates in the operator skill, prompt, and runbook so prerequisite-failure inspection happens before downstream release advancement
3. narrow helper logic that evaluates release dependency metadata plus current tracked issue outcomes into a deterministic blocked/clear decision
4. operator-loop status surfacing for the current release block state and reason
5. focused tests for state evaluation, operator-loop wiring, and the failed-prerequisite regression path

## Non-Goals

This slice does not include:

1. orchestrator dispatch, retry, reconciliation, or tracker claim policy changes
2. a full factory-wide stop-the-line system
3. new tracker transport or broad GitHub normalization refactors
4. generic release planning automation across every future rollout shape
5. automatic repair or rerun of failed prerequisite tickets
6. replacing standing context as the place for durable human release notes beyond the new typed release-state seam

## Current Gaps

Today the checked-in operator workflow preserves release sequencing only as free-form notebook guidance:

1. standing context can mention release order, but there is no typed operator state for prerequisite relationships or blocked release posture
2. the operator prompt/skill instructs the agent to handle plan review, report review, and landing checkpoints, but not a deterministic prerequisite-failure checkpoint
3. operator-loop status surfaces point to notebooks and report-review state, but do not expose whether a release is currently blocked by a failed prerequisite
4. tests cover notebook persistence and report-review prioritization, but not the release regression where a failed prerequisite still allowed later tickets to advance

## Decision Notes

1. Keep this seam operator-local. The issue asks for operator halt behavior before broader stop-the-line support exists, so the first slice should not reopen orchestrator scheduling or tracker lifecycle policy.
2. Add a typed operator release-state file instead of encoding dependency truth only in markdown sections. The operator needs an auditable, machine-readable place to store both configured dependencies and the current blocked posture.
3. Reuse standing context for durable narrative guidance, but keep the release dependency graph and blocked fact in dedicated state so status/tests can inspect it directly.
4. Treat downstream "advancement" narrowly in this slice: operator-owned promotion and landing decisions, not speculative factory dispatch suppression.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that a failed prerequisite blocks downstream release advancement on operator wake-up
2. the rule that operators must not promote or land downstream work while that prerequisite failure remains unresolved
3. the conditions under which the blocked posture may optionally escalate to a broader stop-the-line follow-up, without making that broader system part of this issue

Does not belong here:

1. raw GitHub payload parsing
2. orchestrator dispatch suppression
3. hidden notebook-only conventions that tests cannot inspect

### Configuration Layer

Belongs here:

1. typed derivation of the new operator release-state path for the selected instance
2. any narrow environment/status wiring needed so the operator command can read and update that state

Does not belong here:

1. new `WORKFLOW.md` runtime semantics for core orchestrator scheduling
2. embedding release dependency truth only in prompt text

### Coordination Layer

Belongs here:

1. no orchestrator-runtime changes in this slice
2. an explicit operator-owned release advancement state model kept outside orchestrator retry/dispatch state

Does not belong here:

1. mixing operator release blocking into orchestrator lease, retry, or recovery maps
2. teaching the factory runtime to consume operator notebook state as scheduling truth

### Execution Layer

Belongs here:

1. operator-loop initialization/wiring of the release-state artifact
2. bounded helper execution that inspects dependency metadata and current issue outcomes during a wake-up cycle

Does not belong here:

1. runner changes
2. workspace changes
3. provider-specific assumptions about Codex, Claude, or generic-command

### Integration Layer

Belongs here:

1. the narrow boundary that reads current issue outcomes needed to determine whether prerequisites failed
2. normalization of those outcome facts into an operator release decision without leaking tracker-specific shapes into the prompt text

Does not belong here:

1. broader tracker transport refactors
2. mixing dependency metadata storage with raw GitHub API payloads
3. orchestrator-owned release sequencing policy

### Observability Layer

Belongs here:

1. the operator-local release-state document
2. status/notebook surfacing for the blocked release posture and blocking prerequisite
3. tests and docs that make the blocked release fact inspectable

Does not belong here:

1. mutating tracker state while rendering status
2. inventing a second source of truth for issue outcome beyond normalized tracker facts plus operator-local release metadata

## Architecture Boundaries

### `src/domain/instance-identity.ts`

Owns:

1. typed derivation of the release-state file path under `.ralph/instances/<instance-key>/`
2. naming the canonical operator-local artifact

Does not own:

1. dependency evaluation logic
2. notebook wording
3. tracker reads

### operator release-state helper module

Owns:

1. the typed document schema for release dependency metadata and blocked posture
2. pure evaluation of prerequisite outcomes into `clear` vs `blocked`
3. atomic read/write helpers for that state

Does not own:

1. shell prompt text
2. tracker transport clients
3. orchestrator dispatch decisions

### `skills/symphony-operator/operator-loop.sh`

Owns:

1. creation and exposure of the release-state artifact for the selected instance
2. surfacing the release-state path in loop status artifacts

Does not own:

1. the only definition of release-blocking policy
2. ad hoc dependency parsing logic in shell
3. tracker-specific release heuristics

### `skills/symphony-operator/SKILL.md`, `skills/symphony-operator/operator-prompt.md`, `docs/guides/operator-runbook.md`

Owns:

1. wake-up ordering rules for prerequisite-failure checks
2. the operator-facing rule that downstream release advancement halts while blocked
3. guidance on when to update standing context versus typed release-state artifacts

Does not own:

1. machine-readable state persistence
2. tracker transport details
3. orchestrator runtime behavior

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one narrow operator-policy seam:

1. add a typed release-state artifact under the existing instance-scoped operator state root
2. add pure helper logic for evaluating prerequisite outcomes from stored release metadata plus current issue facts
3. update operator loop/prompt/skill/runbook to require the release-block checkpoint before downstream advancement work
4. expose the release-state path and current posture in operator status artifacts
5. add focused unit/integration tests

Deferred from this PR:

1. automatic factory-wide stop-the-line mode
2. orchestrator dispatch gating based on dependency graphs
3. broad tracker-side dependency normalization beyond what the selected operator seam minimally needs
4. generalized multi-release portfolio management

Why this seam is reviewable:

1. it improves operator correctness without reopening core runtime scheduling
2. it keeps durable release coordination in a typed, inspectable local contract
3. it avoids mixing tracker transport, orchestrator state, and operator prompt changes into one broad refactor

## Operator Release Advancement State Model

This issue does not change the orchestrator runtime state machine, but it does add stateful operator behavior. The release advancement state therefore needs an explicit operator-owned state model.

### State subject

One release state document is keyed by selected instance and stores:

1. release identifier / label
2. dependency metadata for prerequisite and downstream issue relationships
3. the current blocked or clear advancement posture
4. the latest factual reason and timestamps for that posture

### States

1. `unconfigured`
   - no dependency-driven release metadata is defined for the selected instance
2. `configured-clear`
   - release dependency metadata exists and all prerequisites needed for downstream advancement are currently non-failed
3. `blocked-by-prerequisite-failure`
   - at least one prerequisite has a normalized failed outcome, so downstream advancement is halted
4. `blocked-review-needed`
   - metadata is present but incomplete or inconsistent enough that the operator cannot safely determine whether advancement should continue

### Allowed transitions

1. `unconfigured -> configured-clear`
2. `configured-clear -> blocked-by-prerequisite-failure`
3. `configured-clear -> blocked-review-needed`
4. `blocked-by-prerequisite-failure -> configured-clear`
5. `blocked-by-prerequisite-failure -> blocked-review-needed`
6. `blocked-review-needed -> configured-clear`
7. `blocked-review-needed -> blocked-by-prerequisite-failure`

### Contract Rules

1. downstream advancement is allowed only in `configured-clear`
2. `blocked-by-prerequisite-failure` must record the blocking prerequisite issue identifier and factual summary
3. `blocked-review-needed` must fail closed for advancement until the metadata gap is corrected
4. standing context may explain release sequencing, but the current blocked posture must live in typed release-state data

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected decision |
| --- | --- | --- | --- |
| No release dependency metadata configured for this instance | release-state file absent or unconfigured | ordinary issue/PR state only | remain `unconfigured`; do not invent release blocking |
| Release metadata exists and all prerequisites are non-failed | configured prerequisite/downstream mapping | prerequisite issues are open, merged, or otherwise non-failed | record `configured-clear`; ordinary advancement may continue |
| A prerequisite issue is terminal failed | configured prerequisite/downstream mapping | prerequisite issue outcome is failed | record `blocked-by-prerequisite-failure`; do not promote downstream tickets or post `/land` for downstream PRs |
| Multiple prerequisites exist and one fails while another is still running | configured dependency graph | one prerequisite failed, others non-terminal | record `blocked-by-prerequisite-failure`; the first failed prerequisite is sufficient to halt advancement |
| Metadata references an issue that cannot be resolved from current facts | configured dependency graph with missing reference | current tracker snapshot missing or ambiguous for referenced issue | record `blocked-review-needed`; fail closed until corrected |
| Previously failed prerequisite is later repaired and no prerequisite remains failed | existing blocked release-state entry | refreshed prerequisite outcomes no longer failed | transition back to `configured-clear`; advancement may resume on a later wake-up |

## Storage Contract

The new operator release-state document should:

1. live under `.ralph/instances/<instance-key>/release-state.json`
2. use an explicit schema version
3. store both configured release dependency metadata and the current evaluated posture
4. be written atomically like other operator-owned state artifacts
5. remain operator-local and instance-scoped; it is not tracker truth and not orchestrator runtime state

## Observability Requirements

1. operator-loop `status.json` and `status.md` should surface the release-state path
2. operator-facing docs/prompt should tell the operator to treat a blocked prerequisite as a mandatory checkpoint before downstream advancement
3. the blocked posture should be inspectable without reading free-form notebook history
4. standing context should remain available for durable release notes, but not as the sole place where blocked release truth lives

## Implementation Steps

1. Extend operator instance path derivation with a canonical `release-state.json` path.
2. Add a focused operator release-state helper module that:
   - defines the schema
   - reads/writes the document
   - evaluates prerequisite metadata plus current issue outcomes into a posture
3. Update operator-loop wiring/status output so the release-state artifact is initialized and discoverable.
4. Update the operator skill, prompt, and runbook to require the prerequisite-failure checkpoint before downstream advancement work.
5. Add unit tests for release-state transitions and failure-class decisions.
6. Add integration coverage proving the operator loop/status/prompt surface the new checkpoint and artifact.

## Tests And Acceptance Scenarios

### Unit

1. release-state evaluation returns `blocked-by-prerequisite-failure` when any configured prerequisite has failed
2. release-state evaluation returns `blocked-review-needed` when dependency metadata is incomplete or references unresolved issues
3. release-state evaluation returns `configured-clear` when prerequisites are configured and none have failed
4. instance-path helpers expose `release-state.json`

### Integration

1. operator-loop status output includes the release-state path for the selected instance
2. operator prompt places prerequisite-failure inspection before downstream release advancement work
3. notebook/status wiring preserves standing context while making blocked release truth inspectable through the typed artifact

### Acceptance Scenarios

1. Given a dependency-driven release where issue `#111` is a prerequisite for downstream ticket `#112`, when `#111` is failed, then the operator wake-up contract marks the release blocked and does not allow downstream advancement.
2. Given a previously blocked release whose failed prerequisite is later repaired, when the operator refreshes the state, then the release returns to clear posture and downstream advancement may resume.
3. Given malformed or incomplete dependency metadata, when the operator evaluates release state, then the system fails closed with an explicit review-needed posture instead of advancing.

## Exit Criteria

1. repo-owned operator guidance explicitly says prerequisite failure halts downstream release advancement
2. canonical operator-local state preserves the blocked release posture and blocking prerequisite
3. operator-loop status artifacts expose the release-state seam clearly enough to inspect it directly
4. tests cover the failed-prerequisite regression and the clear/review-needed alternatives

## Deferred To Later Issues Or PRs

1. factory-wide stop-the-line orchestration
2. tracker-native dependency graph ingestion for GitHub issues
3. automatic relabeling or queue mutation for blocked releases
4. richer operator UX for editing release dependency metadata
