# Issue 343 Plan: Detached Factory Restart Should Boot From Runtime Home

## Status

- plan-ready

## Goal

Make the supported detached `factory start` / `factory restart` path boot the worker from the selected instance's prepared runtime home under `.tmp/factory-main` instead of silently executing the operator checkout that happened to launch the control command.

This issue is specifically about restoring the runtime-home contract that detached control already documents: after a merge and runtime-home refresh, the next detached restart must run the merged code for that instance even when the operator checkout is a bare repo or otherwise does not reflect the runtime-home `HEAD`.

## Scope

- fix detached launch-source selection so the selected instance's `.tmp/factory-main` runtime home is the source of truth for detached starts and restarts when that runtime home is launchable
- make startup/runtime identity reflect the actual launched runtime home instead of the operator checkout `cwd`
- keep the behavior instance-scoped so external workflows selected with `--workflow` use their own `.tmp/factory-main`, not the shared engine checkout
- add targeted status/control/runtime-freshness coverage so stale operator checkouts cannot masquerade as the running runtime again
- update operator-facing docs only where they currently overstate or obscure the detached runtime-home launch contract

## Non-goals

- the broader installed-package runtime materialization work planned in [docs/plans/218-installed-engine-distribution/plan.md](../218-installed-engine-distribution/plan.md)
- redesigning tracker lifecycle policy, landing policy, or restart-recovery semantics
- changing workspace preparation, bare-mirror refresh policy, or review-loop behavior
- introducing hot reload or automatic runtime self-update beyond the normal restart path
- broad refactors to the operator loop outside the runtime-home freshness and restart seam

## Current Gaps

1. [src/cli/factory-control.ts](../../../src/cli/factory-control.ts) still hardcodes detached launch through `pnpm tsx <ENGINE_ROOT>/bin/symphony.ts run`, so a refreshed `.tmp/factory-main` checkout has no effect on the next detached restart.
2. [src/startup/service.ts](../../../src/startup/service.ts) records runtime identity from `process.cwd()`, so startup snapshots can report the operator checkout as the running runtime even when the instance runtime home is the intended authority.
3. [src/observability/operator-runtime-freshness.ts](../../../src/observability/operator-runtime-freshness.ts) and [bin/check-factory-runtime-freshness.ts](../../../bin/check-factory-runtime-freshness.ts) assume the running detached runtime identity is comparable to the current operator checkout identity, which breaks when detached control ignored the prepared runtime home.
4. The checked-in docs describe `.tmp/factory-main` as the detached runtime checkout for the selected instance, but the launch path does not currently honor that contract.
5. The issue thread explicitly calls out that the fix must hold for all factories, not only self-hosting `symphony-ts`, so the seam must remain instance-relative and work for `--workflow`-selected external repositories too.

## Decision Notes

- Restore the contract from [docs/plans/081-factory-control-cli/plan.md](../081-factory-control-cli/plan.md): detached control should launch "using the current checked-out `.tmp/factory-main`", not whichever checkout invoked the CLI.
- Keep this issue narrowly on source-checkout runtime-home launch semantics. If detached control also needs to support installed packages or runtime-home staging without a checkout, that remains the broader seam in issue `#218`.
- Treat a non-launchable runtime home as an explicit boundary condition. The implementation may support a narrow, typed source-checkout fallback where needed for bootstrap, but it should no longer silently prefer the operator checkout when a launchable runtime home already exists.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in [docs/architecture.md](../../architecture.md).

- Policy Layer
  - belongs: the repository-owned rule that detached restart must boot from the selected instance runtime home once that home has been refreshed
  - belongs: the rule that this applies to any selected workflow instance, not only self-hosting `symphony-ts`
  - does not belong: host-process command assembly or git probing details
- Configuration Layer
  - belongs: resolving the selected instance's runtime-home path, runtime workflow path, and any launchable-entrypoint checks needed to choose the launch source
  - does not belong: tracker lifecycle or operator wake-up policy
- Coordination Layer
  - belongs: the launch-source decision model for detached start/restart and any explicit degraded/fallback outcomes
  - does not belong: restart-recovery of issue runs, retries, or handoff-state transitions
- Execution Layer
  - belongs: running the detached worker from the chosen runtime-home entrypoint and ensuring startup identity is collected from that launched runtime
  - does not belong: tracker mutations, prompt rendering, or workspace-claim policy
- Integration Layer
  - belongs: local filesystem/git/process facts used to determine whether the runtime home is a valid detached launch target
  - does not belong: mixing those host details into tracker adapters or orchestrator logic
- Observability Layer
  - belongs: reporting the actual launched runtime-home identity clearly in startup/status/freshness surfaces
  - does not belong: inventing a second hidden runtime-version source outside the existing startup/status contracts

## Architecture Boundaries

### CLI / detached control seam

Belongs here:

- selecting the detached launch root and command for `factory start` / `factory restart`
- resolving whether the selected instance runtime home is launchable
- keeping the control command instance-relative for self-hosting and `--workflow`-selected external repositories

Does not belong here:

- tracker lifecycle decisions
- orchestrator retry/recovery policy
- broad runtime-distribution staging logic beyond what this issue needs

### Configuration / instance-path seam

Belongs here:

- deriving the runtime home, runtime workflow path, and any companion paths from the selected workflow instance
- exposing a typed runtime-home launch target if the current helpers are too implicit

Does not belong here:

- host process launch side effects
- status rendering
- tracker-specific behavior

### Execution / startup seam

Belongs here:

- launching the worker from the selected runtime home rather than from `ENGINE_ROOT`
- collecting runtime identity from the actual launched checkout or runtime home
- making launch-source failure explicit when the runtime home is missing or invalid for the chosen mode

Does not belong here:

- changing restart-recovery decisions for inherited `symphony:running` issues
- changing workspace preparation behavior
- packaging/install flows from issue `#218`

### Observability / freshness seam

Belongs here:

- startup snapshot identity that matches the actual detached launch root
- runtime freshness assessment that compares the running runtime-home identity against the current operator/runtime state without conflating the two
- status and doc wording that stays honest about where the detached worker actually came from

Does not belong here:

- a new durable policy store
- operator-loop scheduling changes unrelated to restart correctness

### Tracker / workspace / runner seams

- tracker remains unchanged; this issue must not mix tracker transport, normalization, or policy into detached launch selection
- workspace remains unchanged; runtime-home launch selection is not a workspace-preparation policy change
- runner remains unchanged; providers should see the same `symphony run` contract after the detached worker starts

## Slice Strategy And PR Seam

Land this as one reviewable PR on one seam: detached runtime-home launch correctness for source-checkout factories.

What lands in this PR:

1. runtime-home launch-target selection for detached start/restart
2. startup/runtime identity fixes that reflect the real launch root
3. targeted status/freshness and factory-control tests for self-hosting and external-instance cases
4. narrow docs updates where the runtime-home contract is described or consumed

What is deliberately deferred:

1. install-safe runtime-home staging and non-git packaged runtime homes from issue `#218`
2. broader operator-loop or landing-flow redesign
3. any runtime self-update or automatic refresh framework

Why this is reviewable:

- it stays on the detached control/startup/observability seam
- it does not mix tracker, workspace, and orchestrator policy changes
- it directly fixes the concrete stale-restart failure mode while keeping the larger runtime-distribution seam deferred

## Runtime State Model

The affected behavior is a small but explicit state machine for detached launch-source selection.

### State inputs

1. selected workflow instance paths
   - instance root, runtime home, and runtime workflow path derived from the chosen `WORKFLOW.md`
2. runtime-home launchability
   - whether the runtime home contains the files/entrypoint required for detached `symphony run`
3. current operator checkout identity
   - the checkout invoking detached control, used only as an explicit fallback or comparison input where supported
4. control action
   - `start` or `restart`
5. startup identity output
   - the runtime identity the launched worker records once it starts

### Decision states

1. `runtime-home-ready`
   - selected `.tmp/factory-main` is launchable
   - detached control launches from the runtime home
2. `runtime-home-unavailable`
   - selected runtime home is missing or not launchable for the supported source-checkout path
   - detached control either follows an explicit bootstrap fallback contract or fails clearly; it must not silently shadow the runtime home with the operator checkout when the runtime home should have been authoritative
3. `launched-from-runtime-home`
   - detached worker started from the runtime home
   - startup/status identity must report that runtime-home path and `HEAD`
4. `launch-degraded`
   - detached launch could not use the intended runtime-home target and no valid fallback was available
   - control/status surface a clear startup/degraded result

### Allowed transitions

1. `runtime-home-unavailable -> runtime-home-ready`
   - runtime home is refreshed or repaired before the next launch
2. `runtime-home-ready -> launched-from-runtime-home`
   - detached `start`/`restart` launches from the runtime home
3. `runtime-home-unavailable -> launch-degraded`
   - launch target is not valid and the supported path cannot proceed
4. `launched-from-runtime-home -> runtime-home-ready`
   - runtime stops cleanly; the same runtime home remains the next authoritative launch source

## Failure-Class Matrix

| Observed condition                                                      | Local facts available                                                                       | Selected-instance facts available                         | Expected decision                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Self-hosting post-merge restart after `.tmp/factory-main` was refreshed | operator checkout `main` may lag or be bare; selected runtime home exists and is launchable | runtime-home `HEAD` differs from operator checkout `HEAD` | restart from the runtime home; startup/status identity reports the runtime-home `HEAD`                                    |
| External instance started via `--workflow ../target/WORKFLOW.md`        | shared engine checkout invoking CLI; selected target runtime home exists and is launchable  | instance paths resolve to target repo `.tmp/factory-main` | start/restart from the target runtime home, not the shared engine checkout                                                |
| Selected runtime home is missing required launch files                  | selected instance paths resolve, but runtime home is absent or incomplete                   | no launchable runtime-home entrypoint                     | fail clearly or take only the explicit supported bootstrap fallback; do not silently prefer stale operator checkout state |
| Runtime home exists but operator checkout is stale or bare              | operator identity and runtime-home identity differ                                          | runtime home is launchable and was refreshed              | runtime home remains authoritative for detached launch and startup identity                                               |
| Startup snapshot is read after runtime-home launch                      | startup worker is alive and snapshot is readable                                            | runtime-home checkout path is known                       | snapshot/runtime freshness surfaces report the runtime-home path and `HEAD`, not the operator checkout                    |
| Detached runtime is stopped or degraded before freshness comparison     | control state not `running`                                                                 | prior startup snapshot may exist                          | follow normal stopped/degraded control handling before making freshness assertions                                        |

## Storage / Persistence Contract

1. the existing startup snapshot remains the persisted record of what detached runtime actually launched
2. no new durable store is needed for this fix
3. the recorded runtime identity in startup/status must now correspond to the runtime-home launch target rather than the operator checkout `cwd`
4. runtime-freshness assessment continues to compare persisted running identity against current on-disk identity, but the persisted identity must be trustworthy first

## Observability Requirements

1. `factory status` and startup snapshots must surface the actual runtime-home path and `HEAD` for detached launches
2. freshness assessment must no longer report a stale operator checkout as if it were the running runtime when the detached worker booted from the runtime home
3. degraded or fallback launch behavior must be inspectable in control output and/or startup failure summaries
4. docs should make it explicit that the selected instance runtime home is the authoritative detached launch source in source-checkout mode

## Implementation Steps

1. audit detached launch command construction in [src/cli/factory-control.ts](../../../src/cli/factory-control.ts) and introduce a focused helper that resolves the detached launch target from the selected instance runtime home instead of `ENGINE_ROOT`
2. make the helper explicit about runtime-home launchability and any allowed source-checkout fallback/degraded behavior so start/restart semantics are inspectable rather than implicit
3. update detached launch to execute `symphony run` from the chosen runtime-home target and use the selected runtime workflow path consistently
4. update [src/startup/service.ts](../../../src/startup/service.ts) so runtime identity collection reflects the actual launched runtime root instead of the control caller's `cwd`
5. update runtime freshness/status plumbing as needed so the running-versus-current comparison uses the corrected startup identity without special-casing self-hosting
6. extend unit tests around factory control, startup identity, and runtime freshness for:
   - refreshed runtime-home restart with stale operator checkout
   - `--workflow`-selected external instance launch
   - missing/invalid runtime-home launch target behavior
7. update the operator-facing docs that describe post-merge restart/runtime identity so they match the corrected source-of-truth behavior
8. run local QA: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, plus targeted e2e/integration coverage if the final implementation adds or modifies it

## Tests And Acceptance Scenarios

### Unit

1. `factory start` / `factory restart` prefer the selected instance runtime home as the detached launch root when that home is launchable
2. detached launch for an external `--workflow` instance targets that instance's runtime home rather than the shared engine checkout
3. startup snapshot runtime identity reflects the launched runtime-home path, not the operator checkout path
4. runtime-freshness assessment compares the corrected running runtime identity against current on-disk identities without conflating the operator checkout and runtime home
5. missing or invalid runtime-home launch targets produce the explicit supported fallback or degraded result, not a silent stale-checkout launch

### Integration

1. a startup/control-path test with distinct operator-checkout and runtime-home identities proves the detached worker records the runtime-home `HEAD`
2. a control-path test with a target repository selected through `--workflow` proves the runtime-home launch target is instance-relative

### End-to-end / User-visible Contract

1. given a merged self-hosting PR and a refreshed `.tmp/factory-main`, when the operator runs the supported `factory restart` command from a stale bare operator checkout, then the restarted factory reports the merged runtime-home `HEAD`
2. given a shared engine checkout supervising an external repository, when the operator runs `factory start --workflow <target>/WORKFLOW.md`, then the detached runtime comes from `<target>/.tmp/factory-main` and not from the shared engine checkout

### Local Gate

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. local self-review if a reliable review tool is available

## Exit Criteria

1. detached `factory restart` boots from the selected instance runtime home after that runtime home has been refreshed
2. runtime identity/status/freshness surfaces report the launched runtime-home identity rather than the operator checkout identity
3. the fix works for self-hosting and external `--workflow` instances
4. automated tests pin the stale-bare-checkout regression and the multi-instance runtime-home contract
5. installed-package runtime materialization remains explicitly deferred rather than implicitly mixed into this PR

## Deferred Work

1. issue `#218` runtime-distribution/materialization work for installed packages and non-git runtime homes
2. broader runtime-home bootstrap or self-update policy beyond the minimum explicit fallback needed for this issue
3. any operator-loop automation changes that are not required to make detached runtime-home launch correct
