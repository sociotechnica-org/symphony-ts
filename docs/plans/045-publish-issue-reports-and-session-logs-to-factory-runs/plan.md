# Issue 45 Plan: Publish Issue Reports And Session Logs To `factory-runs`

## Status

`plan-ready`

## Goal

Add a detached archive-publication path that reads the canonical local issue artifacts under `.var/factory/issues/<issue-number>/...` plus the generated report outputs under `.var/reports/issues/<issue-number>/...`, then writes a stable per-publication directory into a checked-out `factory-runs` archive repository without making archive publication part of the normal `symphony-ts` run loop or CI contract.

## Scope

This slice covers:

1. a stable target directory layout inside `factory-runs` for one published issue snapshot
2. a versioned `metadata.json` contract that records publication facts, source facts, and copied-log outcomes
3. a detached publication service that copies `report.json`, `report.md`, and available raw session logs or reference manifests into the archive tree
4. a standalone CLI flow for publishing one issue from local canonical artifacts into a local `factory-runs` checkout
5. tests and docs that prove publication failure does not mutate or redefine the canonical local artifact/report contracts

## Non-goals

This slice does not include:

1. changing the canonical local artifact contract from `#43`
2. changing the generated report schema from `#44`
3. embedding archive publication into `symphony run`, orchestrator retries, or normal issue execution flow
4. making `symphony-ts` CI depend on a reachable `factory-runs` remote or a real network publish
5. batch publication, backfill sweeps, or scheduled archive sync loops
6. updating local issue artifacts in place with archive locations after publish
7. redesigning runner log capture beyond the existing log-pointer contract
8. GitHub API automation around creating archive PRs or pushing commits to the archive remote

## Current Gaps

After `#43` and `#44`, `symphony-ts` can persist canonical local issue artifacts and generate detached per-issue reports, but it still lacks a defined publication seam into the separate archive repository:

1. there is no stable `factory-runs` directory layout for published issue snapshots
2. there is no canonical publication metadata contract for repo, issue, branch, PR, timing, session, and source revision facts
3. existing local log pointers can reference raw logs, but there is no policy for copying readable logs versus archiving pointer references when the source is unavailable
4. there is no detached CLI/service that stages issue outputs into an archive checkout while leaving local artifacts canonical and untouched
5. there is no CI-safe test harness that simulates archive publication against a mock local git repository

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in [docs/architecture.md](/Users/jessmartin/Documents/code/symphony-ts/.tmp/factory-main/.tmp/workspaces/sociotechnica-org_symphony-ts_45/docs/architecture.md).

- Policy Layer: publication rules belong here, including the target archive tree shape, the rule that local artifacts remain canonical, the rule that missing logs degrade to copied references instead of blocking publication, and the rule that archive publication remains detached from normal runtime execution.
- Configuration Layer: this slice should add only detached CLI input parsing and path resolution for the source workflow root and the archive checkout path. It should not add new `WORKFLOW.md` runtime settings or make archive publication part of the repository-owned worker contract.
- Coordination Layer: untouched. The orchestrator must not gain publish/retry logic, publication status state, or archive side effects.
- Execution Layer: untouched except for existing local files that the publisher reads. Runner and workspace layers must not change to satisfy archive layout needs.
- Integration Layer: owns the `factory-runs` publication service, publication metadata composition from local/report/git facts, archive-path derivation, file copy/reference rules, and any archive-worktree validation. This is the primary layer touched by the issue.
- Observability Layer: continues to own the canonical local artifact and generated report contracts plus read helpers. It may expose read-side loaders reused by the publisher, but it must not absorb archive-repo policy or git-worktree publication logic.

## Architecture Boundaries

### Integration

Belongs here:

1. the `factory-runs` target path contract and publication-id derivation
2. archive metadata composition from local artifacts, generated reports, and source git facts
3. copying published files into the archive checkout
4. validation that the archive root looks like a writable checkout/worktree
5. partial-success handling for raw logs when a pointer is present but a file cannot be copied

Does not belong here:

1. orchestrator lifecycle decisions
2. markdown report rendering
3. tracker transport or GitHub issue policy
4. mutating the canonical local issue artifacts after publication

### Observability

Belongs here:

1. canonical local artifact readers from `#43`
2. generated report readers/writers from `#44`
3. stable local paths under `.var/factory/...` and `.var/reports/...`

Does not belong here:

1. `factory-runs` directory layout policy
2. archive metadata enrichment from source git state
3. archive worktree writes or publication-side idempotency rules

### CLI / Config

Belongs here:

1. argument parsing for a detached publish command
2. resolving the source workflow path and archive checkout path
3. printing publication results and copied/uncopied log summaries

Does not belong here:

1. publication business logic inline in argument parsing
2. hidden default behavior that makes publication run during normal issue execution

### Coordination / Orchestrator

Belongs here:

1. nothing new in this slice

Does not belong here:

1. archive publication triggers
2. archive publication retries
3. storing publication state inside active runtime state

### Runner / Workspace

Belongs here:

1. no new responsibilities beyond existing session/log-pointer artifacts

Does not belong here:

1. direct writes into `factory-runs`
2. publication metadata assembly
3. archive-aware log-capture behavior

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR because it stays on one detached integration seam:

1. reuse the existing local artifact and report contracts as read-only inputs
2. add a focused archive publication service and CLI
3. add tests against temporary source and archive repositories
4. update docs for the detached publication workflow

This PR deliberately defers:

1. batch or campaign publication commands
2. pushing or opening PRs against the archive remote
3. back-writing archive locations into local artifacts
4. richer source revision capture if later raw artifacts start storing commit SHAs directly
5. any normal-runtime hook that auto-publishes on issue completion

The seam is reviewable because it does not reopen orchestrator coordination or generated report composition; it only adds a new consumer that copies already-canonical local outputs into a separate archive worktree.

## Publication Contract

Write each publication into this stable archive tree:

```text
<factory-runs-root>/
  symphony-ts/
    issues/
      <issue-number>/
        <publication-id>/
          report.json
          report.md
          metadata.json
          logs/
            <session-id>/
              <log-name>...
              <log-name>.pointer.json
```

### Publication ID

Use a stable, filesystem-safe publication id derived from the generated report timestamp when available:

1. prefer `report.generatedAt` rendered as a compact UTC identifier
2. append a short source revision suffix when a relevant SHA is available so repeated publishes remain legible
3. if the generated report is unavailable, fail loudly rather than inventing a publication id from partial inputs

The publication id is archive-oriented, not a new canonical local identifier.

### Published Files

Required files:

1. `report.json`: copied byte-for-byte from the generated local report
2. `report.md`: copied byte-for-byte from the generated local markdown report
3. `metadata.json`: generated by the publication service for archive consumers

Optional files:

1. `logs/<session-id>/<log-name>` when a log pointer resolves to a readable local file
2. `logs/<session-id>/<log-name>.pointer.json` when the source log cannot or should not be copied but the original pointer can be preserved

### `metadata.json`

`metadata.json` should be versioned and include, at minimum:

1. archive schema version
2. publication id
3. published-at timestamp
4. source repo name
5. issue number and issue identifier when available
6. branch name
7. pull request numbers and URLs when available
8. report generated-at timestamp
9. issue start/end timestamps when available
10. orchestrator session/run identifiers when available
11. runner session ids
12. source revision facts:
    - relevant SHA
    - optional base SHA / commit range when derivable without changing local contracts
    - source checkout path used for publication
13. source artifact paths used to compose the publication
14. per-log publication results, including copied archive path or preserved pointer reference
15. an explicit partial/failure note when some logs could not be copied

The metadata contract should permit nulls for unavailable facts rather than synthesizing guessed values.

## Log Publication Rules

Use the existing log-pointer contract as the archive input and apply these rules:

1. if a log pointer location resolves to a readable local file, copy the file into `logs/<session-id>/`
2. if the pointer location is present but not a readable local file, write `<log-name>.pointer.json` with the original pointer metadata and mark the log as `referenced`
3. if both the location and archive location are absent, record the log entry in `metadata.json` as `unavailable` and continue
4. log publication problems should make the publication partial, not silently complete
5. missing or uncopiable logs must not block report and metadata publication unless the core report artifacts are missing

## Read / Write Model

This slice does not change orchestrator runtime state, but the publisher still needs an explicit detached write model.

### Publication states

1. `not-started`: no archive directory exists for the selected issue/publication id
2. `staging`: the publisher has loaded local artifacts and is writing archive files into the target directory
3. `published`: required files (`report.json`, `report.md`, `metadata.json`) were written successfully; logs may be complete or partial
4. `failed`: required publication files could not be written; the archive directory may be absent or left only with temporary files

### Rules

1. local artifacts and generated reports are always the canonical source of truth
2. publication writes must be atomic enough that `metadata.json`, `report.json`, and `report.md` are never left truncated
3. a failed publish must not mutate local artifacts or generated reports
4. rerunning the same publication command for the same inputs should either rewrite the same publication directory atomically or fail clearly on an unexpected conflict; it must not duplicate nested directory layers

## Failure-Class Matrix

| Observed condition                                                                       | Local facts available                             | Expected behavior                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Generated report and local issue artifacts are both present                              | canonical report plus local raw artifacts         | publish archive snapshot successfully                                                                             |
| Report files are missing for the issue                                                   | raw artifacts only, no generated report           | fail loudly and instruct the operator to generate the local report first                                          |
| Some log pointers resolve to readable local files                                        | report, metadata inputs, readable log files       | copy those logs and record copied archive paths in `metadata.json`                                                |
| Some log pointers are present but unreadable, remote-like, or already archived elsewhere | pointer metadata only                             | write pointer manifests and mark the publication partial without blocking the required files                      |
| No session logs exist for the issue                                                      | report and local artifacts only                   | publish report and metadata with an explicit `no-logs-available` note                                             |
| Archive target path is not a writable checkout/worktree                                  | source artifacts only                             | fail before mutating the archive tree                                                                             |
| Archive write fails midway through required files                                        | source artifacts only                             | surface a typed publication error, clean up temp files when possible, and leave local artifacts untouched         |
| Publication command is rerun for an existing publication id                              | full source inputs and existing archive directory | handle idempotently by atomic rewrite or explicit conflict error; never create duplicate nested publication trees |

## Storage And Persistence Contract

This issue adds a durable archive-output contract in the separate archive repository, not a new canonical local state contract.

Contract rules:

1. the archive tree is append-only at the publication-directory level; a later publish for the same issue gets a new publication directory unless it is an intentional idempotent rewrite of the same publication id
2. `metadata.json` is the archive-side publication manifest and the only new canonical document introduced by this issue
3. copied logs live under `logs/`, but pointer-reference JSON files are allowed when the raw file is not available
4. archive publication must not require editing `.var/factory/...` or `.var/reports/...`
5. archive publication must be testable against a local mock repo/worktree without real network access

## Observability Requirements

1. structured logs or CLI output should name the issue number, publication id, archive root, and per-log outcome
2. publication errors should clearly distinguish missing local prerequisites from archive write failures
3. partial log publication should be visible in the command result and in `metadata.json`
4. no new status-surface coupling is required in this slice

## Implementation Steps

1. Add a focused archive publication module in a new integration seam, for example `src/integration/factory-runs/`, with typed publication contracts and path helpers.
2. Reuse the existing read-side observability services to load the canonical local issue artifacts and generated report outputs for one issue.
3. Add source-revision helpers that collect the relevant source SHA from the current source checkout without changing the local artifact schema; keep missing commit-range facts explicit instead of guessed.
4. Implement `metadata.json` derivation from report facts, raw artifact facts, session ids, PR info, branch info, source revision facts, and per-log publication results.
5. Implement required file writes and log copy/reference behavior with atomic writes for `report.json`, `report.md`, and `metadata.json`.
6. Add a detached CLI entry point for publishing one issue into a provided archive checkout path.
7. Update docs with the publish workflow, required prerequisites, and the rule that local artifacts remain canonical even when archive publication fails.
8. Add tests for path derivation, metadata composition, log copy/reference fallback, and end-to-end publish behavior against a temp archive repo.

## Tests And Acceptance Scenarios

### Unit

1. publication paths derive `<archive-root>/symphony-ts/issues/<issue-number>/<publication-id>/...` from a source issue report plus archive root
2. `metadata.json` includes the required repo, issue, branch, PR, timing, session, and source revision fields with explicit nulls for unavailable facts
3. a readable local log pointer is copied into `logs/<session-id>/...`
4. an unreadable or non-file pointer yields a `.pointer.json` file and marks the publication partial
5. publication id derivation is filesystem-safe and stable for the same generated report timestamp/source revision inputs

### Integration

1. publishing a completed issue with generated reports writes `report.json`, `report.md`, `metadata.json`, and copied or referenced logs into a temporary archive repo
2. publishing an issue with no logs still succeeds and records the absence in metadata
3. publishing without generated report files fails clearly and leaves the archive repo unchanged
4. rerunning publication for the same issue/publication id behaves idempotently or fails with an explicit conflict, according to the chosen implementation

### End-to-end / Repo Gate

1. a realistic local issue artifact tree and generated report from the current runtime can be published into a mock `factory-runs` repository without invoking the orchestrator
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `codex review --base origin/main`

## Acceptance Scenarios

1. Given canonical local artifacts and generated reports for issue `45`, when the operator runs the detached publish command with a local `factory-runs` checkout, then the archive repo contains `symphony-ts/issues/45/<publication-id>/report.json`, `report.md`, `metadata.json`, and any copied or referenced logs.
2. Given a session log pointer that references a readable local file, when publication runs, then the raw log is copied under `logs/<session-id>/...` and `metadata.json` records the archive path.
3. Given a session log pointer that cannot be copied, when publication runs, then publication still writes the required files, emits a partial result, and records a pointer manifest plus failure details in `metadata.json`.
4. Given missing generated report files, when publication runs, then the command fails clearly and does not corrupt local artifacts or create a misleading archive snapshot.

## Exit Criteria

1. `factory-runs` archive structure is defined and implemented for one issue publication
2. archive outputs have stable structure and versioned metadata
3. local canonical artifacts and generated reports remain unchanged when publication succeeds or fails
4. publication is operationally detached from `symphony-ts` CI and normal run execution
5. tests prove archive publication works against a local mock repo and handles missing logs/report prerequisites correctly

## Deferred Work

1. batch publication commands and backfill tools
2. archive-repo commit, push, or PR automation
3. back-writing archive locations into local artifact pointers
4. richer source commit-range capture if future artifacts or tracker facts expose it directly
5. archive browsing or status surfaces over many published issues

## Decision Notes

1. The first publication slice should target a checked-out archive worktree, not a network push path, so the integration remains CI-testable and operationally separate from the source repo runtime.
2. Local artifacts and generated reports stay canonical; archive publication is a downstream copy/export step, not a second writer into the local contracts.
3. Pointer-reference files are preferable to silently dropping missing logs because archive consumers need to distinguish `copied`, `referenced`, and `unavailable`.
4. The issue body names `https://github.com/sociotechinca-org/factory-runs`, which appears to contain an org-name typo relative to `sociotechnica-org/symphony-ts`; implementation should accept an explicit archive checkout path/remote instead of hard-coding that string.

## Revision Log

- 2026-03-10: Initial plan drafted and marked `plan-ready` for detached `factory-runs` publication.
