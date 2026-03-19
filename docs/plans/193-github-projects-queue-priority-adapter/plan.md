# Issue 193 Plan: GitHub Projects Adapter For Tracker-Native Queue Priority

## Status

- plan-ready

## Goal

Add a GitHub tracker adapter seam that reads a configured GitHub Projects V2 field, normalizes that field into Symphony's tracker-neutral `issue.queuePriority` contract, and keeps GitHub Projects schema details contained inside the tracker boundary.

## Scope

- extend GitHub tracker config so operators can opt into queue-priority mapping from one GitHub Projects V2 field
- add GitHub client transport for reading the configured project item field values needed by ready-issue normalization
- add GitHub-only normalization that converts the configured field value into the existing `QueuePriority` contract
- populate normalized `queuePriority` on GitHub `RuntimeIssue` values returned by ready/running/failed issue reads and direct issue fetches
- add GitHub adapter tests with a mock server that exercises configured, missing, and unusable project-field data
- document the GitHub configuration seam and fallback behavior

## Non-goals

- changing orchestrator dispatch order in this issue
- changing the tracker-neutral `QueuePriority` contract from issue `#192`
- adding Linear queue-priority transport or normalization
- exposing raw GitHub Projects field IDs, option IDs, or GraphQL payloads outside the tracker boundary
- redesigning status surfaces or reports beyond any minimal contract-preserving assertions
- broad GitHub tracker refactors unrelated to queue-priority transport and normalization

## Current Gaps

- `QueuePriorityConfig` only exposes `enabled`, so the GitHub adapter has no repo-owned config for which project field to read
- `src/tracker/github-client.ts` normalizes REST issue payloads directly to `queuePriority: null`, so GitHub cannot project tracker-native priority today
- the GitHub adapter has no transport seam for fetching Projects V2 item field values associated with an issue
- there is no GitHub-specific normalization helper that converts project field values into the tracker-neutral rank/label contract while rejecting provider-specific leakage upward
- the mock GitHub harness does not currently simulate Projects V2 field queries, so CI cannot prove this feature without real network calls

## Decision Notes

- Keep the config repo-owned and explicit. The operator should name the project field to read instead of relying on implicit board conventions.
- Keep GitHub project transport and normalization adjacent but separated: GraphQL transport in `github-client`, field-to-contract normalization in a focused helper/module, orchestration unchanged.
- Preserve the tracker-neutral runtime contract from `#192`; GitHub-specific IDs and option shapes must terminate at the tracker boundary.
- Missing, unconfigured, or unusable project data must degrade to `queuePriority: null` so current ready-work behavior remains backward-compatible until ordering work lands.
- This issue should stay one PR by limiting the slice to GitHub config, transport, normalization, tests, and docs.

## Spec Alignment By Abstraction Level

- Policy Layer
  - belongs: defining GitHub queue-priority as one way to populate the existing normalized ordering hint
  - belongs: documenting fallback semantics when project data is absent or unusable
  - does not belong: orchestrator queue ordering changes or GitHub GraphQL details in repo-wide policy
- Configuration Layer
  - belongs: typed GitHub queue-priority config for project/field selection and validation
  - does not belong: live GitHub API calls or hidden defaults derived from tracker payloads
- Coordination Layer
  - belongs: no behavioral changes in this slice beyond continuing to consume normalized `RuntimeIssue`
  - does not belong: GitHub Projects queries or field parsing
- Execution Layer
  - belongs: no changes
  - does not belong: tracker-native priority metadata
- Integration Layer
  - belongs: GitHub transport for Projects V2 field reads, normalization into `QueuePriority`, and adapter-owned fallback behavior
  - does not belong: leaking raw project schema or option payloads into `src/domain/` or `src/orchestrator/`
- Observability Layer
  - belongs: tests and docs that keep normalized queue-priority facts inspectable for future projection
  - does not belong: a broader status/report redesign in this slice

## Architecture Boundaries

### Belongs in this issue

- `src/domain/workflow.ts`
  - extend GitHub queue-priority config to carry the GitHub-specific selection data needed by the adapter
  - keep the generic `enabled` seam intact while scoping provider-specific fields to GitHub config only
- `src/config/workflow.ts`
  - parse and validate the optional GitHub queue-priority config shape
  - fail clearly on malformed GitHub config before runtime polling starts
- `src/tracker/github-client.ts`
  - add GitHub transport for fetching project item field values and thread that data into normalized issue building
  - keep GraphQL query details and pagination inside the client
- new focused GitHub normalization helper(s)
  - map GitHub project field values into `QueuePriority`
  - reject malformed or unsupported GitHub field payloads at the integration boundary
- `tests/support/mock-github-server.ts`
  - simulate the GitHub Projects data needed by the client and normalization tests
- GitHub unit/integration tests plus docs

### Does not belong in this issue

- orchestrator ordering changes
- Linear adapter changes
- a generic cross-tracker project-field framework
- status/TUI/report projection work
- mixing GitHub transport, normalization, plan-review policy, and PR lifecycle logic into one hot file

## Layering Notes

- `config/workflow`
  - owns parsing and validation of GitHub queue-priority config
  - does not inspect live issue or project payloads
- `tracker`
  - owns GitHub transport, GitHub normalization, and fallback to `queuePriority: null`
  - does not require the orchestrator to know what a GitHub Project item or field option is
- `workspace`
  - untouched
  - does not carry tracker queue metadata
- `runner`
  - untouched
  - does not participate in GitHub project reads
- `orchestrator`
  - untouched in behavior
  - continues to consume normalized issues only
- `observability`
  - may rely on normalized `queuePriority` later
  - is not the source of truth for GitHub project semantics

## Slice Strategy And PR Seam

This issue fits in one reviewable PR by keeping the change at the GitHub tracker edge:

1. extend GitHub config with explicit queue-priority field selection
2. add GitHub client transport for the required Projects V2 field facts
3. normalize those facts into `issue.queuePriority`
4. prove the seam with mock-backed tests and small doc updates

This avoids combining:

- orchestrator dispatch policy
- Linear work
- broader observability changes
- unrelated GitHub lifecycle or plan-review behavior

## Runtime State Model

Not applicable for this slice. The issue changes tracker-boundary transport and normalization, not retries, continuations, reconciliation, leases, or handoff states.

## Failure-Class Matrix

| Observed condition | Local facts available | Normalized tracker facts available | Expected behavior |
| --- | --- | --- | --- |
| GitHub queue-priority config is absent | resolved tracker config | none | keep current behavior; GitHub issues normalize with `queuePriority: null` |
| GitHub queue-priority config is malformed | workflow path and raw front matter | none | fail workflow loading with a field-specific config error |
| Issue is not on the configured project or has no matching project item field value | resolved GitHub config, issue number | issue present, project field absent | normalize to `queuePriority: null`; issue remains eligible |
| Project field value is present but empty/unset | resolved GitHub config, issue number | project field resolves to null/empty | normalize to `queuePriority: null` |
| Project field value type is unsupported for this seam | GraphQL payload shape | raw GitHub field metadata only inside tracker | fail or discard at the GitHub normalization boundary according to the documented supported types; do not leak raw payload upward |
| Project field value cannot be mapped to a stable numeric rank | configured mapping facts plus raw option/text value | no valid normalized priority | normalize to `queuePriority: null` and log/test the fallback contract |
| Multiple ready issues have valid GitHub-derived priorities | normalized issues | populated `queuePriority` values | existing comparator/order helpers can consume the normalized values without GitHub-specific knowledge |
| GitHub project GraphQL request fails | request error, repo/project config | no updated queue priority data | surface a tracker error for the fetch rather than silently inventing stale priority facts |

## Storage / Persistence Contract

- no new durable local storage
- GitHub project field values remain adapter-local transport facts
- only the normalized `issue.queuePriority` contract crosses into the runtime domain
- existing issue snapshots, status payloads, and reports remain unchanged unless they already carry normalized issue data

## Observability Requirements

- config validation errors must identify the malformed `tracker.queue_priority` field
- tests should lock in the fallback behavior for missing or unusable GitHub project data
- structured logging should stay sufficient to diagnose GitHub transport failures without exposing raw project-schema details to higher layers

## Implementation Steps

1. Extend the GitHub queue-priority workflow config shape in `src/domain/workflow.ts` and `src/config/workflow.ts` with the minimal GitHub-specific selection fields needed for this adapter slice.
2. Add focused GitHub field-normalization helpers that convert supported project field values into `QueuePriority`.
3. Add GitHub client GraphQL transport for reading the configured Projects V2 field values associated with issues returned by the adapter.
4. Thread the fetched field facts into GitHub issue normalization so `fetchReadyIssues()`, `fetchRunningIssues()`, `fetchFailedIssues()`, and `getIssue()` populate `queuePriority` when configured.
5. Extend the mock GitHub server to serve the required Projects V2 responses and failure cases.
6. Add unit coverage for:
   - valid and invalid GitHub queue-priority config
   - supported GitHub field normalization paths
   - fallback to `null` for missing, empty, or unusable field values
7. Add integration coverage proving the GitHub tracker returns normalized queue priority from mock project data without changing the rest of the issue contract.
8. Update `README.md` and `WORKFLOW.md` comments with the GitHub configuration seam and fallback semantics.
9. Run local self-review plus repo checks before opening the PR.

## Tests And Acceptance Scenarios

### Unit

- workflow parsing accepts omitted GitHub queue-priority config
- workflow parsing accepts valid GitHub queue-priority config and rejects malformed fields with field-specific errors
- GitHub field normalization converts supported project values into stable `rank` and `label` facts
- GitHub field normalization falls back to `null` for missing/unset/unusable values without leaking raw schema upward

### Integration

- mock-backed GitHub client/tracker tests return `queuePriority` for issues whose configured project field is populated
- GitHub issue reads still return `queuePriority: null` when queue-priority config is omitted
- GitHub issue reads degrade cleanly when the issue lacks a configured project item or field value

### Repo Gate

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- local self-review when a reliable review tool is available

## Acceptance Scenarios

1. Given a GitHub tracker config with queue priority disabled or omitted, GitHub issues continue to normalize with `queuePriority: null`.
2. Given a GitHub tracker config that names a supported project field and an issue whose project item has a mapped value, `fetchReadyIssues()` returns that issue with populated normalized queue priority.
3. Given a configured issue whose GitHub project field is missing or unset, the issue remains readable and normalizes to `queuePriority: null`.
4. Given malformed GitHub queue-priority config, workflow loading fails before polling with a clear config error.
5. Given GitHub-derived normalized priorities on returned issues, the existing queue-priority comparator can order them without any GitHub-specific input.

## Exit Criteria

- GitHub tracker config can opt into one project-field-based queue-priority source with explicit validation
- GitHub adapter transport and normalization populate tracker-neutral `issue.queuePriority` when configured
- missing or unusable GitHub project data degrades to `queuePriority: null`
- tests cover supported normalization and fallback paths using the mock GitHub harness
- the PR stays limited to the GitHub tracker boundary and docs/tests required to support it

## Deferred To Later Issues Or PRs

- orchestrator queue ordering changes that actively prioritize ready work by `queuePriority`
- richer GitHub support for additional project-field shapes beyond the first supported seam if needed
- Linear adapter population of the same normalized contract
- status/report/TUI projection changes centered on queue priority
- any cross-tracker policy that combines queue priority with dispatch pressure, retries, or other orchestration signals

## Revision Log

- 2026-03-19: Initial draft created for issue `#193` and marked `plan-ready`.
