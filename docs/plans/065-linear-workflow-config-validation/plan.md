# Issue 65 Plan: Linear Workflow Config And Validation

## Status

- approved

## Goal

Add a typed `tracker.kind: linear` workflow contract so `WORKFLOW.md` can describe a Linear-backed tracker at the configuration boundary, with defaults and validation aligned to the upstream Symphony/Elixir seams, while keeping Linear-specific assumptions out of the orchestrator.

## Scope

- add a discriminated tracker config contract that supports:
  - `tracker.kind: github-bootstrap`
  - `tracker.kind: linear`
- resolve and validate the Linear workflow fields needed in this slice:
  - `tracker.endpoint`
  - `tracker.api_key` / token resolution
  - `tracker.project_slug` or equivalent required project scope
  - optional `tracker.assignee`
  - `tracker.active_states`
  - `tracker.terminal_states`
- apply Linear defaults that match the upstream Elixir config seam where that seam is already established:
  - default endpoint
  - default active states
  - default terminal states
- keep validation at `src/config/` so malformed Linear config fails before orchestration
- add focused tests for successful parsing and clear boundary failures
- document a Linear `WORKFLOW.md` example snippet for future adapter work
- add the smallest possible runtime seam needed to keep the existing GitHub execution path type-safe after `tracker` becomes a union

## Non-goals

- implementing a Linear tracker client, GraphQL transport, normalization, or tracker reads/writes
- making `pnpm tsx bin/symphony.ts run` dispatch real Linear work in this issue
- encoding Linear state names or eligibility rules in the orchestrator
- redesigning the broader workflow schema outside the tracker config seam
- inventing speculative Linear workpad/comment fields that are not yet required by a stable downstream contract

## Current Gaps

- `src/domain/workflow.ts` models `tracker` as a single GitHub-bootstrap-only shape
- `src/config/workflow.ts` ignores `tracker.kind` and always requires GitHub-specific fields
- workflow validation currently cannot distinguish:
  - supported tracker kinds
  - unsupported tracker kinds
  - missing Linear credentials
  - missing Linear project scope
- tests only cover GitHub bootstrap workflow parsing
- README and the checked-in workflow example only document GitHub bootstrap usage
- the CLI/run path currently constructs `GitHubBootstrapTracker` directly, so a tracker-config union needs an explicit boundary to avoid type leakage or unsafe casts

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: documenting the repository-owned workflow contract for choosing `tracker.kind: linear`
  - does not belong: hard-coded Linear workflow state names inside orchestrator control flow
- Configuration Layer
  - belongs: parsing front matter, applying defaults, resolving env-backed credentials, normalizing tracker config into typed unions, and emitting clear validation failures
  - does not belong: Linear API calls, project lookups, or tracker eligibility behavior
- Coordination Layer
  - belongs: no new behavior in this slice
  - does not belong: interpreting Linear config fields or compensating for missing Linear validation
- Execution Layer
  - belongs: at most a narrow runtime guard/factory seam so execution code does not assume every tracker config is GitHub-shaped
  - does not belong: Linear transport, issue polling, or config parsing
- Integration Layer
  - belongs: no transport work yet; only preserving a future seam where a Linear adapter can consume the validated Linear config later
  - does not belong: mixing future GraphQL concerns into `src/config/`
- Observability Layer
  - belongs: surfacing precise config error messages in tests and user-facing failures
  - does not belong: tracker-specific status rendering or new runtime telemetry

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - add discriminated tracker config types for GitHub bootstrap and Linear
- `src/config/workflow.ts`
  - branch on `tracker.kind`
  - parse GitHub config through the existing path
  - parse Linear config through a dedicated resolver with defaults and validation
  - keep all malformed-input checks at the boundary
- minimal CLI/runtime wiring only if needed to avoid unsafe casts after the tracker config union is introduced
- unit tests that exercise both tracker kinds and validation failures
- docs/example updates for Linear workflow front matter

### Does not belong in this issue

- adding a `src/tracker/linear-*` client/adapter
- changing orchestrator dispatch, retry, or handoff logic
- teaching workspace or runner layers anything about Linear
- mixing tracker transport, normalization, and policy into the workflow loader
- broad docs churn unrelated to the workflow contract

## Slice Strategy And PR Seam

This issue should stay one reviewable PR by landing only the config seam required before any Linear adapter can exist:

1. introduce a typed tracker union
2. parse and validate Linear config in `src/config/`
3. keep the run path compile-safe with a narrow tracker-construction boundary
4. add tests and docs for the new contract

This seam is reviewable on its own because it deliberately defers:

- all Linear API transport
- all Linear payload normalization
- all orchestrator policy changes
- all workpad/comment-write behavior

## Runtime State Model

Not applicable for this slice. The issue is limited to configuration loading and validation and does not change orchestration state, retries, reconciliation, leases, or handoff transitions.

## Validation Failure Matrix

| Observed input                                                            | Boundary facts available          | Expected result                                                                                                                         |
| ------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tracker.kind` omitted with existing GitHub fields present                | front matter map only             | preserve current GitHub bootstrap behavior for backward compatibility or require explicit defaulting to `github-bootstrap` in one place |
| `tracker.kind: github-bootstrap` with missing required GitHub field       | front matter map only             | `ConfigError` names the missing GitHub field                                                                                            |
| `tracker.kind: linear` with no `tracker.api_key` and no env fallback      | front matter map plus process env | `ConfigError` clearly states that a Linear API key/token is required                                                                    |
| `tracker.kind: linear` with missing `tracker.project_slug`                | front matter map only             | `ConfigError` clearly states that project scope is required                                                                             |
| `tracker.kind: linear` with malformed `active_states` / `terminal_states` | front matter map only             | `ConfigError` names the invalid field and expected type                                                                                 |
| `tracker.kind: linear` with omitted endpoint/states                       | front matter map only             | workflow loads successfully using upstream-aligned defaults                                                                             |
| unknown `tracker.kind` value                                              | front matter map only             | `ConfigError` clearly states the supported tracker kinds                                                                                |

## Storage / Persistence Contract

- no new durable storage is introduced
- `ResolvedConfig` remains the typed in-memory contract returned from `loadWorkflow`
- any future Linear tracker adapter should consume the normalized `ResolvedConfig.tracker` union rather than reparsing raw workflow fields

## Observability Requirements

- config failures must remain loud and field-specific at workflow-load time
- tests should assert the exact field names involved in the error so operator-facing failures stay actionable
- no new logs or status-surface fields are required in this slice

## Implementation Steps

1. Split tracker config types in `src/domain/workflow.ts` into:
   - `GitHubBootstrapTrackerConfig`
   - `LinearTrackerConfig`
   - `TrackerConfig` as the discriminated union
2. Refactor `src/config/workflow.ts` so tracker resolution is delegated to focused helpers instead of one inline object literal.
3. Preserve the GitHub bootstrap resolver behavior, with `tracker.kind` defaulting cleanly to `github-bootstrap` for compatibility if that is required by existing fixtures and checked-in workflow files.
4. Add a Linear resolver that:
   - requires `kind: linear`
   - applies the upstream default endpoint
   - applies upstream default active/terminal states
   - resolves the Linear API key/token from workflow config and, if needed, documented env fallback
   - accepts optional assignee routing / worker identity filter
   - requires non-empty project scope
5. Add explicit unsupported-kind validation with a message listing supported kinds.
6. Add the narrowest runtime construction guard needed so code that instantiates the GitHub tracker narrows on `tracker.kind` explicitly instead of assuming every tracker config is GitHub-shaped.
7. Add unit coverage for:
   - GitHub bootstrap backward compatibility
   - valid Linear workflow parsing
   - defaulted Linear endpoint/states
   - missing Linear token
   - missing Linear project scope
   - unsupported tracker kind
8. Add a docs/example workflow snippet for `tracker.kind: linear` in the most relevant checked-in docs surface.

## Tests And Acceptance Scenarios

### Unit

- `loadWorkflow` still parses the current GitHub bootstrap workflow
- `loadWorkflow` parses a valid Linear workflow and returns a `tracker.kind === "linear"` config with:
  - endpoint defaulted correctly when omitted
  - active states defaulted correctly when omitted
  - terminal states defaulted correctly when omitted
- `loadWorkflow` rejects:
  - unknown tracker kind
  - Linear config without token
  - Linear config without project scope
  - malformed Linear state arrays

### Integration

- CLI/status-path code paths that only need workflow loading continue to work with a valid Linear workflow definition
- run-path wiring remains explicit about unsupported execution for `linear` until the adapter issue lands

### Repo Gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `codex review --base origin/main`

## Acceptance Scenarios

1. A repository `WORKFLOW.md` with `tracker.kind: linear`, a valid token, and a project slug loads successfully and returns a typed Linear tracker config.
2. A Linear workflow with omitted endpoint or state lists still loads, using the upstream default endpoint and state defaults.
3. A Linear workflow missing token material fails early with a clear `ConfigError`.
4. A Linear workflow missing project scope fails early with a clear `ConfigError`.
5. An unsupported tracker kind fails early before any orchestrator or tracker execution starts.
6. Existing GitHub bootstrap workflow fixtures still load unchanged.

## Exit Criteria

- `WORKFLOW.md` parsing supports both GitHub bootstrap and Linear tracker config shapes
- malformed or incomplete Linear workflow config fails at the config boundary with clear field-specific errors
- the orchestrator and tracker transport layers remain free of Linear config parsing logic
- the existing GitHub bootstrap workflow contract remains intact
- the change lands as one reviewable PR without bundling Linear transport or orchestration work

## Deferred To Later Issues Or PRs

- Linear GraphQL transport and API client
- Linear issue normalization into the runtime issue model
- tracker factory support that can dispatch real Linear work
- Linear workpad/comment lifecycle behavior
- any repo-owned policy about default Linear state names beyond the upstream config defaults already established in the Elixir reference

## Decision Notes

- This slice should mirror the upstream Elixir config seam where it is already explicit: `endpoint`, `api_key`, `project_slug`, `assignee`, `active_states`, and `terminal_states`.
- Backward compatibility for existing GitHub bootstrap workflows matters more than forcing every current workflow to add `tracker.kind` immediately. If the current fixtures rely on implicit GitHub bootstrap behavior, keep that compatibility in the config layer rather than pushing churn into unrelated files.
- The runtime guard after config resolution is intentionally narrow. It exists only to keep TypeScript honest about the new tracker union until the Linear integration issue lands.
- Do not add speculative workpad/comment fields unless the downstream Linear behavior issue identifies a concrete contract. This issue should establish the config seam first, not pre-commit the next slice’s policy surface.

## Revision Log

- 2026-03-10: Initial plan created and marked `plan-ready` for issue #65.
- 2026-03-10: Plan approved on the issue thread; implementation started.
