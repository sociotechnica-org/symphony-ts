# Issue 256 Plan: Durable Raw Log Evidence In `factory-runs` Publications

## Status

`plan-ready`

## Goal

Make archived `factory-runs` issue publications preserve durable raw runner-log evidence by default when that evidence exists locally, so published reports remain useful for later forensic analysis instead of degrading to `logs copied: 0` / `logs referenced: 0`.

## Scope

This slice covers:

1. extending archive publication evidence resolution beyond canonical `logPointers` when the current issue report already identifies additional raw runner-log artifacts
2. reusing the existing Codex session-log matching/report-enrichment seam to surface durable raw-log file paths to archive publication
3. refining publication metadata so copied, referenced, unavailable, and absent evidence are distinguished precisely
4. focused unit, integration, and end-to-end coverage for copied raw logs, referenced raw logs, and genuinely missing evidence
5. docs updates where the archive-publication contract now guarantees stronger raw-log preservation behavior

## Non-goals

This slice does not include:

1. redesigning terminal-report generation or terminal-reporting orchestration state
2. changing tracker lifecycle policy, review-loop policy, or archive publication triggers
3. making archive publication depend on live network access or remote storage
4. broad runner refactors to make every provider persist new canonical local artifacts in the same PR
5. introducing archive git push/PR automation
6. redefining generated issue reports as the canonical source of truth instead of local issue artifacts

## Current Gaps

Today the publication service is correct only when canonical artifact log pointers are already complete:

1. `src/integration/factory-runs.ts` publishes only `IssueArtifactLogPointer` inputs, so sessions with empty `logPointers` produce no archived raw-log evidence
2. the Codex app-server session path currently records `logPointers: []`, even though matching raw Codex JSONL session logs may exist locally under `~/.codex/sessions/...`
3. the existing Codex report enricher can already match those local JSONL files and records them as report `tokenUsage.sessions[].sourceArtifacts`, but archive publication ignores that evidence
4. publication metadata currently conflates “no evidence existed locally” with “the publisher failed to preserve evidence that was available through another local seam”
5. current integration coverage proves pointer-based copies and pointer-manifest fallbacks, but it does not prove that archive publication preserves raw Codex session logs when canonical pointers are absent

## Decision Notes

1. Keep this issue on the archive-publication seam. The main product bug is that publication ignores already-discovered raw log evidence, not that the orchestrator lacks another state machine.
2. Reuse existing Codex report-enrichment matching instead of inventing a second archive-only heuristic if possible. If a shared helper extraction is needed, keep it narrow and reusable by both report enrichment and archive publication.
3. Prefer additive evidence resolution: canonical `logPointers` remain first-class inputs, and report-discovered raw runner logs act as a fallback/additional source when pointers are empty or incomplete.
4. Metadata must make it obvious whether a publication was partial because evidence truly did not exist locally, because only pointer references were available, or because a copy/reference attempt failed.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the rule that archived reports should preserve raw log evidence when that evidence exists locally
2. the rule that canonical artifact log pointers remain authoritative when present, but publication may consume additional local evidence already derived by the reporting layer
3. the rule that missing evidence stays explicit and inspectable rather than silently reported as success

Does not belong here:

1. file-copy mechanics
2. Codex JSONL parsing details
3. tracker or PR lifecycle decisions

### Configuration Layer

Belongs here:

1. no new workflow knobs in this slice; publication continues to use the existing archive-root contract
2. any minimal typed option plumbing needed to pass already-resolved evidence inputs into the publisher

Does not belong here:

1. publication heuristics hidden in config parsing
2. provider-specific archive rules in `WORKFLOW.md`

### Coordination Layer

Belongs here:

1. intentionally untouched; the existing terminal-report generation/publication trigger remains the same

Does not belong here:

1. new retry or reconciliation state just for richer archive evidence
2. archive evidence matching logic

### Execution Layer

Belongs here:

1. at most a narrow shared runner-side helper extraction if needed to identify Codex raw session logs from canonical session facts
2. preserving runner/backend identity facts already emitted in canonical session artifacts

Does not belong here:

1. archive publication policy
2. tracker-facing status logic
3. broad app-server transcript persistence redesign in this PR

### Integration Layer

Belongs here:

1. archive publication evidence resolution
2. choosing whether evidence is copied, referenced, unavailable, or absent
3. archive metadata composition for raw-log evidence outcomes
4. publication-time path sanitization and copy/reference writes

Does not belong here:

1. orchestrator lifecycle transitions
2. report rendering
3. runner-process control

### Observability Layer

Belongs here:

1. exposing report-derived runner-log evidence in a stable read-side shape when publication needs it
2. keeping report/source-artifact facts legible and reusable across detached consumers
3. projecting clearer publication notes/status when evidence is partial or unavailable

Does not belong here:

1. archive git worktree mutation rules
2. tracker completion policy
3. implicit provider-specific behavior that only archive publication understands

## Architecture Boundaries

### `src/integration/factory-runs.ts`

Owns:

1. collecting all archive-publication evidence candidates for a given issue
2. preferring canonical pointer-backed logs first, then report-derived raw log artifacts as fallback/additional evidence
3. writing copied log files or pointer/reference manifests into the archive tree
4. producing precise archive metadata and notes about evidence coverage

Does not own:

1. Codex log parsing details if those can live in a shared helper
2. report markdown/JSON generation
3. orchestrator retry or terminal-report receipt state

### `src/observability/`

Owns:

1. report-side typed access to session source artifacts already discovered by enrichment
2. any small read helper that exposes “report-derived raw log evidence candidates” without coupling the publisher to full report-rendering internals

Does not own:

1. archive path layout
2. publication-side copy/reference decisions
3. tracker or runner transport policy

### `src/runner/`

Owns:

1. any extracted Codex session-match helper that turns canonical session facts into local JSONL evidence candidates
2. keeping the match semantics shared between report enrichment and archive publication when both need the same evidence

Does not own:

1. archive metadata assembly
2. detached publication status rules
3. orchestrator status receipts

### Tests

Own:

1. coverage for the archive-publication seam when canonical pointers are present, absent, or supplemented by report-derived evidence
2. keeping fixture setup readable through shared helpers instead of ad hoc temp-root duplication

Do not own:

1. speculative production refactors unrelated to the evidence path

## Layering Notes

- `config/workflow`
  - stays unchanged except for existing archive-root usage
  - must not gain provider-specific archive toggles
- `tracker`
  - untouched
  - must not absorb archive evidence policy
- `workspace`
  - remains only the source of local files/workspaces
  - must not learn archive publication behavior
- `runner`
  - may contribute a shared Codex session-log matching helper
  - must not take ownership of archive metadata or worktree writes
- `orchestrator`
  - remains the existing trigger for report generation/publication
  - must not gain new post-terminal state machinery for this slice
- `observability`
  - can expose report/session evidence in a reusable typed shape
  - must not become the archive writer

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR by staying on one narrow seam: archive publication should preserve raw log evidence that the local runtime already knows how to find.

Current PR contents:

1. add or extract a typed evidence-discovery helper for Codex raw session logs
2. teach `factory-runs` publication to consume both canonical pointers and report-derived raw log evidence without duplicating or mislabeling entries
3. tighten metadata/notes to explain copied, referenced, unavailable, and absent evidence precisely
4. add focused tests and docs for that behavior

Deferred from this PR:

1. broad canonical artifact schema changes for all providers
2. new terminal-reporting runtime states
3. remote archive uploads or additional archive backfill tooling
4. provider-wide raw transcript persistence redesign beyond the concrete Codex-backed archive gap

Why this seam is reviewable:

1. it preserves the existing orchestrator trigger and archive layout
2. it keeps tracker, workspace, and lifecycle policy untouched
3. it fixes the user-visible archive evidence gap with one detached integration/read-side improvement instead of a broad runtime rewrite

## Runtime State / Failure Matrix

This issue does not change retries, continuations, reconciliation, leases, or handoff states. A new orchestrator runtime state machine is therefore not required for this slice.

The detached archive-evidence path still needs an explicit failure matrix:

| Observed condition                                                                                          | Local facts available                                                     | Expected decision                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Canonical session log pointer resolves to a readable local file                                             | issue artifacts plus readable pointed file                                | copy the log into the archive and record it as `copied`                                                             |
| Canonical pointer exists but local file is unreadable or missing                                            | issue artifacts plus pointer metadata only                                | write a pointer/reference manifest and record it as `referenced`                                                    |
| Canonical pointers are empty, but report/session evidence identifies a readable Codex JSONL file            | canonical session facts plus readable matched Codex JSONL file            | copy the raw Codex session log into the archive and record it as `copied`                                           |
| Canonical pointers are empty, report/session evidence identifies only an unreadable or missing raw log path | canonical session facts plus derived path or artifact reference only      | preserve a reference manifest and record it as `referenced` if a meaningful path/reference exists                   |
| No canonical pointers exist and no report/session evidence can identify any local raw log                   | canonical session facts only                                              | record explicit `unavailable` / `absent` evidence notes without claiming success                                    |
| Multiple raw evidence sources describe the same session/log                                                 | pointer plus report-derived evidence or duplicate report-derived evidence | deduplicate deterministically and prefer the strongest local-copy source                                            |
| A matched raw log copy fails mid-publication                                                                | readable source was found but archive copy failed                         | preserve a reference manifest when possible, mark the publication partial, and keep required report files published |

## Storage / Persistence Contract

This slice keeps the current systems of record:

1. canonical issue artifacts under `.var/factory/...` remain canonical
2. generated issue reports under `.var/reports/...` remain detached derived outputs
3. `factory-runs` publication remains a detached archive copy/reference surface

Additional contract rules for this issue:

1. archive publication may consume report-derived raw runner-log evidence when canonical pointers are absent or incomplete
2. copied raw logs must land under the existing publication `logs/` tree
3. reference manifests must remain durable enough that archive readers can tell what local evidence existed but could not be copied
4. metadata must distinguish “no evidence existed” from “evidence existed but only a reference was preserved”

## Observability Requirements

1. archive metadata must report copied, referenced, unavailable, and absent evidence counts/entries precisely
2. when publication falls back to report-derived Codex evidence, the resulting archive entry must still name the source session and source path clearly
3. terminal-report receipts/status summaries should remain truthful when publication is partial because evidence was referenced or absent
4. docs should make it clear that archive publication now preserves local raw log evidence more aggressively, while local artifacts remain canonical

## Implementation Steps

1. Inspect the current report/session evidence shape and extract the smallest reusable helper for discovering matched Codex raw session-log files from canonical session facts.
2. Extend archive publication evidence collection so it merges:
   - canonical `IssueArtifactLogPointer` entries
   - report-derived raw runner-log artifacts for sessions whose canonical pointers are empty or incomplete
3. Normalize deduplication and precedence rules so one session/log is published once, preferring a readable local file over a weaker reference-only artifact.
4. Update publication metadata and notes to reflect the richer evidence outcomes precisely.
5. Add or update integration tests for:
   - pointer-backed copied logs
   - pointer-manifest fallback
   - Codex raw-log copy when canonical pointers are absent
   - explicit unavailability when no raw evidence exists
6. Add an end-to-end or fixture-backed regression that exercises automatic archive publication with durable raw-log evidence for a Codex-backed terminal run.
7. Update README or reporting docs where the archive-publication contract needs to state the stronger raw-log preservation behavior.

## Tests And Acceptance Scenarios

### Unit

1. evidence collection deduplicates canonical pointer and report-derived raw log sources deterministically
2. precedence rules prefer a readable local source over a weaker reference-only source for the same session/log
3. metadata classification distinguishes copied, referenced, unavailable, and absent evidence correctly

### Integration

1. `publishIssueToFactoryRuns()` copies canonical pointer-backed logs exactly as before
2. `publishIssueToFactoryRuns()` writes pointer manifests when canonical pointers exist but the local file is unreadable
3. `publishIssueToFactoryRuns()` copies matched Codex JSONL raw logs when canonical pointers are empty but the report/session evidence identifies a local file
4. `publishIssueToFactoryRuns()` records an explicit partial/unavailable outcome when no raw evidence can be found through either seam

### End-to-End

1. a Codex-backed terminal run that generates a report and publishes to `factory-runs` leaves archived raw log evidence alongside the report by default

## Acceptance Scenarios

1. Representative archived Codex-backed reports include copied raw session logs when those logs exist locally, even if canonical artifact pointers were empty.
2. When a raw log cannot be copied but a meaningful reference exists, the archive includes a durable reference manifest instead of silently dropping the evidence.
3. When no raw evidence exists locally, metadata says so explicitly rather than implying the publisher overlooked it.
4. Existing pointer-backed publication behavior remains intact.

## Exit Criteria

1. archive publication no longer depends exclusively on canonical `logPointers` for durable raw-log evidence
2. Codex-backed archived reports preserve local raw session-log evidence by default when available
3. publication metadata explains evidence coverage precisely enough for later debugging
4. tests cover both pointer-backed and report-derived evidence paths
5. docs describe the updated archive evidence behavior

## Deferred To Later Issues Or PRs

1. canonical artifact schema changes that persist richer raw-log pointers directly for all providers
2. archive backfill automation for previously published partial reports
3. provider-specific raw log preservation beyond the concrete Codex-backed seam addressed here
4. any broader redesign of report enrichment, terminal-report receipts, or archive git automation
