# Issue 148 Plan: Factory Detached TUI UTF-8 Contract

## Status

- plan-ready

## Goal

Make the detached factory runtime render the status TUI correctly by default when launched through the supported factory-control path, even if the parent shell exports an invalid or unavailable locale.

This slice should keep the fix inside the detached factory control/watch seam: choose a valid UTF-8 locale for the detached runtime, launch `screen` in UTF-8 mode, and make the supported observation path align with that encoding contract.

## Scope

- inspect and update the detached launch path used by `symphony factory start` and `symphony factory restart`
- normalize locale environment selection instead of inheriting arbitrary `LC_ALL` / `LANG` from the parent shell
- ensure detached sessions launch through `screen -U`
- define how the supported detached observation path (`symphony factory watch` plus documented attach guidance) relates to the UTF-8 contract
- add targeted regression coverage for locale selection, launch arguments, and failure behavior when no usable UTF-8 locale exists
- update operator-facing docs and guidance where the supported detached encoding contract needs to be explicit

## Non-goals

- redesigning the TUI layout, copy, or token-accounting behavior
- replacing `screen` with another detached-session backend
- broad remote terminal compatibility work
- changing tracker, runner, or orchestrator behavior unrelated to detached factory launch/observation encoding
- introducing new workflow settings for locale selection in this slice

## Current Gaps

- `src/cli/factory-control.ts` currently launches detached sessions with `screen -dmS ...` and inherits the caller environment blindly
- if the parent shell exports a value such as `LC_ALL=C.UTF-8` on a host that does not actually provide that locale, the detached worker can start under a broken encoding contract and the TUI renders mojibake
- the detached control code has no checked-in locale normalization helper, so correctness depends on operator shell folklore instead of repo-owned policy
- the supported watch path is documented, but the detached encoding contract itself is not yet explicit in code or docs
- current tests lock the detached command argv but do not cover environment normalization or `screen -U`

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repo-owned rule that detached factory control must establish a valid UTF-8 terminal contract by default instead of inheriting arbitrary locale state
  - does not belong: tracker lifecycle policy, review-loop policy, or a general terminal-compatibility policy for every shell the repo might ever run under
- Configuration Layer
  - belongs: fixed factory-control defaults for locale preference order, environment normalization, and any reusable constants for the detached launch contract
  - does not belong: new `WORKFLOW.md` fields or tracker-specific configuration
- Coordination Layer
  - belongs: `factory start` / `restart` deciding whether detached launch can proceed, fail clearly, or surface degraded startup because no usable UTF-8 locale can be selected
  - does not belong: orchestrator polling, retry budgeting, reconciliation, or issue handoff behavior
- Execution Layer
  - belongs: constructing the detached `screen` launch argv and env, including `screen -U` and explicit locale env assignment for the child runtime
  - does not belong: tracker mutations, prompt rendering, or status snapshot semantics
- Integration Layer
  - belongs: probing host locale availability through local process integrations such as `locale -a`, and integrating with GNU Screen as the local detached-session boundary
  - does not belong: tracker transport/normalization changes or hidden dependence on operator shell startup files
- Observability Layer
  - belongs: clear startup failures or warnings when no UTF-8 locale can be used, plus documentation of the supported observation contract
  - does not belong: a TUI redesign or a second persistent status schema

## Architecture Boundaries

### Factory control seam

Belongs here:

- host-locale discovery and selection for detached runtime launch
- explicit detached launch env construction
- `screen` argv construction for start and restart
- startup failure messaging when UTF-8 requirements cannot be satisfied

Does not belong here:

- tracker-specific policy
- generic terminal rendering logic inside the observability layer

### Watch / observation seam

Belongs here:

- keeping `symphony factory watch` as the supported detached observation path
- documenting how supported observation relates to the detached UTF-8 launch contract
- ensuring the supported path does not quietly depend on shell-local operator workarounds

Does not belong here:

- introducing a new interactive attach client in this issue
- making raw `screen -r` the primary supported path again

### Observability seam

Belongs here:

- concise operator-facing errors or warnings that explain when locale selection failed
- docs that state detached control owns the encoding contract

Does not belong here:

- changing status snapshot structure
- adding locale state to durable runtime artifacts unless the implementation proves it is required

### Tracker / workspace / runner seams

Untouched except as existing dependencies of the launched runtime:

- tracker adapters should not learn about locales or `screen -U`
- workspace code should not absorb detached screen policy
- runner implementations should continue to see a normal process environment once factory control has normalized it

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR because it stays on one detached-runtime seam:

1. add a focused UTF-8 locale selection helper for factory control
2. update detached `screen` launch args and env construction
3. add targeted unit/integration coverage for locale normalization and failure cases
4. update docs for the supported detached encoding contract

Deferred from this PR:

- replacing `screen`
- remote shell/session compatibility work
- broader TUI feature work from `#133`
- broader operator packaging/runtime bootstrap work from `#136`
- adding user-configurable locale overrides unless the narrow fix proves insufficient

This seam is reviewable because it stays inside factory control, host integration, and operator docs. It does not mix tracker changes, orchestrator retry changes, or TUI redesign.

## Runtime State Model

This issue reuses the existing factory-control state model from `#81`, but the detached start path gains an explicit launch-preparation step for encoding safety.

### Launch States

1. `prepare-launch`
   - `factory start` / `restart` resolves runtime paths and selects a usable UTF-8 locale for the detached worker
2. `launch-detached`
   - control launches `screen` with `-U` and the normalized locale environment
3. `await-healthy-runtime`
   - existing health checks wait for a live detached runtime and current status snapshot
4. `running`
   - detached runtime is healthy under the explicit UTF-8 launch contract
5. `launch-failed`
   - control fails clearly before or during launch because locale requirements or detached startup requirements were not satisfied

### Allowed Transitions

- `prepare-launch -> launch-detached`
- `prepare-launch -> launch-failed`
- `launch-detached -> await-healthy-runtime`
- `launch-detached -> launch-failed`
- `await-healthy-runtime -> running`
- `await-healthy-runtime -> launch-failed`

The existing `stopped` / `degraded` / `running` control-state classification remains the operator-facing read model after launch.

## Failure-Class Matrix

| Observed condition                                                                | Local facts available                                                                        | Normalized locale facts available                                                                             | Expected decision                                                                                   |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Parent shell exports valid installed UTF-8 locale                                 | inherited env, `locale -a` includes that locale                                              | selected locale matches supported UTF-8 locale                                                                | launch detached runtime with explicit UTF-8 env and `screen -U`; startup can proceed                |
| Parent shell exports invalid or unavailable UTF-8 locale such as `LC_ALL=C.UTF-8` | inherited env contains bad value, `locale -a` does not include it                            | selector ignores invalid value and chooses a real installed UTF-8 locale such as `en_US.UTF-8` when available | launch proceeds with normalized env; no silent mojibake from inherited bad locale                   |
| Parent shell exports non-UTF-8 locale but host has installed UTF-8 locale         | inherited env is non-UTF-8, `locale -a` contains at least one UTF-8 locale                   | selector chooses supported UTF-8 locale from installed list                                                   | launch proceeds with explicit UTF-8 env and `screen -U`                                             |
| Host has no usable UTF-8 locale at all                                            | `locale -a` returns only non-UTF-8 locales or probe fails with authoritative negative result | selector cannot choose a locale                                                                               | fail clearly before detached startup with actionable message; do not fall back silently to mojibake |
| `screen` launches without `-U` regression                                         | launch argv omits UTF-8 flag                                                                 | locale may still be valid                                                                                     | tests fail; detached launch contract is considered broken                                           |
| Supported watch path is used after normalized detached start                      | detached runtime was started with explicit UTF-8 contract                                    | watch path remains read-only and documented as supported observation path                                     | operator guidance points to the supported path; docs do not require ad hoc shell workarounds        |

## Storage / Persistence Contract

- no new durable files are required for this slice
- locale selection remains an in-memory launch-time decision inside factory control
- existing runtime status snapshots remain the source of truth for detached health after launch

## Observability Requirements

- `factory start` / `restart` must fail with a clear message if no usable UTF-8 locale is available
- tests should lock the detached launch argv and env contract so `screen -U` and explicit locale env cannot drift silently
- docs should state that the supported factory-control path owns detached encoding normalization
- if the implementation surfaces warnings in human-readable output, keep them concise and specific to the detected locale problem

## Implementation Steps

1. Add a focused locale-normalization helper in or near `src/cli/factory-control.ts` that:
   - inspects relevant inherited locale variables
   - probes installed locales through a narrow host integration
   - selects one valid UTF-8 locale according to an explicit preference order
   - returns either normalized env values or a clear failure
2. Extend the factory-control host dependencies so the detached launcher can be tested with explicit `env` and locale-probe results instead of shelling out blindly in unit tests.
3. Update detached launch construction to:
   - invoke `screen` with `-U`
   - pass explicit locale env for the detached child runtime
   - keep the existing detached `run` acknowledgment contract intact
4. Keep `factory restart` on the same corrected start path rather than building a second locale-handling code path.
5. Review `src/cli/factory-watch.ts` and operator docs so the supported watch path is described consistently with the detached UTF-8 contract, without introducing a new attach workflow in this issue.
6. Add tests for locale selection, `screen -U`, normalized env forwarding, and explicit failure when no usable UTF-8 locale exists.
7. Update `README.md`, `docs/guides/self-hosting-loop.md`, and any touched operator guidance if command examples or watch guidance need to mention the repo-owned UTF-8 behavior.

## Tests And Acceptance Scenarios

### Unit

- locale selector keeps a valid installed inherited UTF-8 locale
- locale selector rejects an inherited UTF-8-looking locale when it is not installed and falls back to an installed UTF-8 locale
- locale selector chooses an installed UTF-8 locale when inherited locale is non-UTF-8 or absent
- locale selector fails clearly when no installed UTF-8 locale exists
- detached launch uses `screen -U`
- detached launch forwards the normalized locale env and preserves the existing run-ack flag contract
- `factory restart` reuses the same normalized start path

### Integration / e2e

- `symphony factory start` from a process env containing a bad locale value launches the detached runtime with normalized UTF-8 env and reaches a healthy control state
- if the locale probe reports no usable UTF-8 locale, detached startup fails before presenting a misleading healthy runtime

### Manual acceptance scenarios

1. Start the detached factory from a shell exporting `LC_ALL=C.UTF-8` on a host where that locale is unavailable; the supported start path still yields a correctly rendered detached TUI instead of mojibake.
2. Restart the detached factory from the same bad inherited shell; the runtime again launches with the normalized UTF-8 contract.
3. Use the supported detached observation path after startup and verify the operator guidance no longer depends on shell-local locale folklore.
4. On a host with no usable UTF-8 locale, `factory start` fails clearly with an actionable message instead of silently launching a broken TUI.

## Exit Criteria

- detached factory start and restart no longer inherit an invalid locale blindly
- detached `screen` launch always uses `-U`
- invalid inherited locale values do not silently produce mojibake when a usable UTF-8 locale exists
- lack of any usable UTF-8 locale fails clearly or follows one explicit documented fallback path
- tests lock the detached launch encoding contract
- docs describe the supported detached watch/start behavior without relying on operator folklore

## Deferred

- raw attach helpers or read-only attach tooling beyond the current documented watch path
- user-configurable locale override knobs
- broader terminal portability work across remote shells or unsupported host setups
- unrelated TUI rendering or truthfulness improvements

## Decision Notes

- Keep locale normalization in factory control rather than scattering shell workarounds through docs. The bug is a detached launch-contract bug, not an operator-memory bug.
- Prefer explicit failure over silent fallback to a non-UTF-8 locale. A broken but “successful” detached TUI is harder to detect and debug than a clear startup error.
- Keep the watch path read-only and documented; this issue is about making the detached runtime render correctly by default, not about reintroducing raw worker-terminal attach as the primary operator surface.
