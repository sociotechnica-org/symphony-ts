# Issue 325 Plan: Conditional External-Instance Factory Restarts

## Status

- plan-ready

## Goal

Stop the operator from restarting detached factories for external instances after every successful landing when neither the running `symphony-ts` runtime nor the selected instance `WORKFLOW.md` contract actually changed.

## Scope

1. define an explicit operator-facing restart assessment that distinguishes runtime-engine drift from selected-workflow drift instead of treating every post-merge checkpoint as a restart trigger
2. record enough startup/runtime identity for the running detached factory to tell whether it started against the current engine checkout and the current selected `WORKFLOW.md`
3. update operator guidance so self-hosting keeps its current merged-code restart behavior, while external instances restart only when the runtime or workflow contract is stale
4. add tests that pin the new decision contract and prevent regressions back to unconditional external-instance restarts

## Non-goals

1. changing tracker lifecycle states, landing semantics, or the guarded-landing policy
2. redesigning the detached factory-control commands or the operator wake-up sequence outside the restart decision seam
3. hot-reloading workflow changes without a restart
4. treating arbitrary target-repository changes as restart triggers when `WORKFLOW.md` did not change
5. moving repository-owned runtime-contract rules out of `WORKFLOW.md`

## Current Gaps

1. [`src/observability/operator-runtime-freshness.ts`](../../../src/observability/operator-runtime-freshness.ts) only compares the running factory runtime `HEAD` against the operator checkout `HEAD`, so it cannot tell whether an external-instance workflow changed or whether an external merge was otherwise a no-op for runtime purposes
2. [`src/startup/service.ts`](../../../src/startup/service.ts) persists runtime engine identity in the startup snapshot, but it does not record the selected `WORKFLOW.md` identity the running process actually loaded
3. [`skills/symphony-operator/operator-prompt.md`](../../../skills/symphony-operator/operator-prompt.md) and [`skills/symphony-operator/SKILL.md`](../../../skills/symphony-operator/SKILL.md) still instruct the operator to restart after any successful landing, which is correct for self-hosting but too broad for external repositories
4. [`docs/guides/operator-runbook.md`](../../guides/operator-runbook.md) still describes the post-merge restart as unconditional instead of conditional for external instances
5. current tests cover runtime-head freshness and operator prompt ordering, but they do not pin the external-instance case where a landed PR changes neither the engine checkout nor `WORKFLOW.md`

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in [`docs/architecture.md`](../../architecture.md).

- Policy Layer
  - belongs: the rule that external-instance restarts happen only when the running engine or the selected `WORKFLOW.md` contract is stale
  - does not belong: treating every merge in the target repository as if it changed the runtime
- Configuration Layer
  - belongs: deriving the selected workflow path and any normalized workflow-identity input needed for restart assessment
  - does not belong: tracker lifecycle decisions or operator wake-up sequencing rules
- Coordination Layer
  - belongs: the restart-assessment state model that decides `restart now`, `defer`, or `no restart`
  - does not belong: tracker transport details or raw git probing scattered through the operator prompt
- Execution Layer
  - belongs: startup-time capture of the running process's workflow identity plus prompt/skill instructions for when to restart the detached runtime
  - does not belong: tracker comment parsing or landing-command policy
- Integration Layer
  - belongs: collecting current engine/workflow identities from the operator checkout and selected instance root at the boundary
  - does not belong: broad target-repository diff inspection unrelated to the runtime/workflow seam
- Observability Layer
  - belongs: surfacing why a restart is or is not required so operators can inspect the decision
  - does not belong: a second hidden policy store outside snapshots, status, docs, and tests

## Architecture Boundaries

### Belongs in this issue

1. startup and observability identity capture
   - persist the running engine identity and the selected `WORKFLOW.md` identity together in the startup snapshot or adjacent status-visible contract
   - make the running-versus-current comparison inspectable and testable
2. restart assessment policy
   - refactor the current freshness helper into an explicit runtime/workflow restart assessment for external instances
   - preserve self-hosting behavior as the natural case where a merged `symphony-ts` PR changes the runtime engine
3. operator guidance
   - update the prompt, skill, and runbook so post-merge restart instructions for external instances are conditional instead of automatic
4. tests
   - pin unit decision outcomes
   - pin startup/status parsing for the new recorded identity
   - pin operator prompt wording for the conditional external-instance path

### Does not belong in this issue

1. tracker-side merge detection or landing-state redesign
2. a generic repository change classifier for files outside `WORKFLOW.md`
3. orchestrator retry, reconciliation, or lease refactors unrelated to operator restart decisions
4. broader operator prompt cleanup unrelated to restart policy

## Layering Notes

- `config/workflow`
  - may expose a small helper for canonical workflow-path resolution or workflow-content identity
  - should not own post-merge restart policy
- `tracker`
  - remains unchanged for this slice
  - should not become the source of runtime/workflow freshness decisions
- `workspace`
  - remains unchanged apart from continuing to provide the selected instance/runtime roots already derived from the workflow
  - should not absorb operator restart heuristics
- `runner`
  - remains unchanged
  - should not infer when detached factories must restart after merge
- `orchestrator`
  - consumes the selected workflow at startup but should not gain special external-instance restart branches for this issue
  - should not compensate for missing operator/runtime identity observability
- `observability`
  - owns the normalized restart assessment and the recorded runtime/workflow identity surface
  - should not turn into a tracker or operator command runner

## Slice Strategy And PR Seam

Land this as one reviewable PR focused on one seam: replace unconditional external-instance post-merge restart guidance with a typed runtime/workflow restart assessment backed by recorded startup identity.

This stays reviewable because it limits the patch to:

1. one identity-capture seam for the running process
2. one assessment helper for restart decisions
3. prompt/skill/runbook wording that consumes that helper's contract
4. targeted unit and integration coverage

This issue should not expand into landing automation redesign, tracker changes, or a generic target-repo diff framework.

## Runtime State Model

This behavior is stateful because the operator must compare what the detached runtime started with against what is current on disk after a merge or checkout update.

### State inputs

1. running engine identity
   - the `symphony-ts` checkout identity recorded by the detached runtime at startup
2. current engine identity
   - the operator checkout identity currently on disk
3. running workflow identity
   - the selected `WORKFLOW.md` identity recorded by the detached runtime at startup
4. current workflow identity
   - the selected `WORKFLOW.md` identity currently on disk
5. control state
   - whether the detached runtime is running, stopped, or degraded
6. factory activity
   - whether the instance is idle or busy when a restart-worthy drift is detected

### Decision states

1. `fresh`
   - running engine and running workflow both match current on-disk identities
   - no restart is needed
2. `stale-runtime-idle`
   - engine changed, factory is idle
   - restart now
3. `stale-runtime-busy`
   - engine changed, factory is busy
   - defer restart until a safe checkpoint
4. `stale-workflow-idle`
   - `WORKFLOW.md` changed, factory is idle
   - restart now so the detached runtime reloads the repository-owned contract
5. `stale-workflow-busy`
   - `WORKFLOW.md` changed, factory is busy
   - defer restart until a safe checkpoint
6. `stale-runtime-and-workflow`
   - both changed
   - same idle/busy split as above, but the summary must make both causes explicit
7. `unavailable`
   - one or more required identities cannot be determined
   - do not guess; surface the missing fact and require inspection
8. `stopped`
   - detached runtime is not running
   - follow the normal health-recovery flow instead of freshness restart logic

### Allowed transitions

1. startup writes `fresh` baseline identities for the running detached runtime
2. a merge or local update can change current engine identity, current workflow identity, or both
3. operator assessment maps those drift facts plus current activity into `restart now`, `defer`, or `no restart`
4. after a restart, the new startup snapshot becomes the baseline for the next comparison

## Failure-Class Matrix

| Observed condition | Local facts available | Recorded running facts available | Expected decision |
| --- | --- | --- | --- |
| External-instance PR merged, operator checkout unchanged, selected `WORKFLOW.md` unchanged | current engine identity matches prior engine; current workflow identity matches prior workflow | running engine identity and running workflow identity present | no restart; record that the merge did not change runtime/workflow inputs |
| External-instance PR merged, selected `WORKFLOW.md` changed, engine unchanged, factory idle | current workflow identity differs; engine identity matches | running workflow identity present | restart now so the detached runtime reloads the new workflow contract |
| External-instance PR merged, selected `WORKFLOW.md` changed, engine unchanged, factory busy | same as above plus active work exists | running workflow identity present | defer restart and surface workflow-stale busy posture |
| `symphony-ts` engine checkout advanced, external instance still runs old runtime, factory idle | current engine identity differs; workflow identity matches | running engine identity present | restart now |
| `symphony-ts` engine checkout advanced, factory busy | current engine identity differs; active work exists | running engine identity present | defer restart until safe checkpoint |
| Either running workflow identity or current workflow identity is unavailable | one side missing | startup snapshot incomplete or current file unreadable | do not guess from merge events alone; surface unavailable assessment |
| Detached runtime stopped or degraded | control state is not `running` | any recorded identities may be stale | use normal recovery/start flow first, not freshness restart logic |

## Storage / Persistence Contract

1. the startup snapshot remains the canonical persisted record of what identities the currently running detached runtime started with
2. the selected `WORKFLOW.md` identity must be stored alongside the existing runtime engine identity so later operator passes can compare running versus current inputs without inferring from merge events
3. the current operator-side comparison may read the selected `WORKFLOW.md` from disk and compute its identity on demand
4. no new durable operator-local policy store should be introduced for this slice

## Observability Requirements

1. the restart assessment summary must say whether drift is from the engine, the workflow, or both
2. startup/status parsing must preserve inspectable recorded workflow identity, not only runtime engine identity
3. operator-facing docs and prompt text must make the external-instance conditional restart rule explicit
4. tests must fail if guidance regresses to unconditional external-instance restarts

## Implementation Steps

1. define a small normalized identity shape for the selected `WORKFLOW.md` that is stable enough for comparison, likely including canonical path plus a content fingerprint and any error classification needed for unavailable cases
2. capture that workflow identity during startup alongside the existing runtime engine identity and thread it through startup parsing plus any status/control surfaces that already expose startup identity
3. refactor [`src/observability/operator-runtime-freshness.ts`](../../../src/observability/operator-runtime-freshness.ts) into an operator restart assessment that:
   - compares running versus current engine identity
   - compares running versus current workflow identity
   - keeps stopped/unavailable handling explicit
   - distinguishes idle versus busy restart-worthy drift
4. update [`bin/check-factory-runtime-freshness.ts`](../../../bin/check-factory-runtime-freshness.ts) and nearby call sites to emit the richer assessment without changing the bounded probe workflow
5. update operator guidance in:
   - [`skills/symphony-operator/operator-prompt.md`](../../../skills/symphony-operator/operator-prompt.md)
   - [`skills/symphony-operator/SKILL.md`](../../../skills/symphony-operator/SKILL.md)
   - [`docs/guides/operator-runbook.md`](../../guides/operator-runbook.md)
   so self-hosting still restarts after merged runtime code while external instances restart only when runtime/workflow drift is detected
6. add or update tests for the new identity parsing and restart decision contract
7. run local QA: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`

## Tests And Acceptance Scenarios

### Unit

1. restart assessment reports `fresh` when running/current engine identities and running/current workflow identities all match
2. restart assessment requests restart when only workflow identity changed and the instance is idle
3. restart assessment defers restart when only workflow identity changed and the instance is busy
4. restart assessment requests restart when only runtime engine identity changed and the instance is idle
5. restart assessment surfaces an unavailable state instead of guessing when workflow identity cannot be read
6. startup snapshot parsing round-trips the recorded workflow identity

### Integration

1. operator-loop prompt capture for an external workflow instructs conditional restart based on runtime/workflow drift instead of unconditional restart after any landing
2. operator-loop prompt capture for self-hosting still instructs restart from merged code after self-hosted merges
3. CLI freshness output/json includes enough detail to distinguish runtime drift from workflow drift

### End-to-end / User-visible Contract

1. given an external instance where a merged PR changes files outside `WORKFLOW.md` and the engine checkout is unchanged, the checked-in operator contract does not instruct an automatic detached-factory restart
2. given an external instance where `WORKFLOW.md` changes, the checked-in operator contract and restart assessment both require a restart before ordinary queue work resumes

### Local Gate

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. local self-review if a reliable review command is available

## Exit Criteria

1. external-instance restart policy is conditional on actual runtime/workflow drift instead of unconditional post-merge restart
2. the running detached runtime records enough identity to compare against the current selected `WORKFLOW.md`
3. operator docs and prompt text explain the conditional restart rule clearly
4. automated tests cover the no-op external merge case plus restart-worthy runtime/workflow changes
5. self-hosting behavior remains intact

## Deferred Work

1. broader restart triggers for repository-owned docs outside `WORKFLOW.md`
2. automatic runtime hot-reload without restart
3. generic repo-diff reporting for external-instance merges
4. any redesign of the operator wake-up order beyond this restart decision seam

## Decision Notes

1. Use `WORKFLOW.md` as the external-instance restart contract boundary because repo instructions already define it as the repository-owned runtime contract. Comparing whole-repo `HEAD`s would be too broad and would recreate the same false-positive restart problem on unrelated merges.
2. Keep the comparison in a focused observability/operator helper rather than scattering raw git checks through prompt text. The operator should consume a typed assessment, not re-derive policy ad hoc.
3. Preserve self-hosting behavior by making it a consequence of the same rule: when `symphony-ts` lands runtime code, engine drift exists, so restart remains required.

## Revision Log

- 2026-04-02: Initial plan created for issue `#325` and prepared for plan-review handoff.
