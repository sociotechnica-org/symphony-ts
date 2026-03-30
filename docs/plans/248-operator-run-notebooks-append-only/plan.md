# Issue 248 Plan: Append-Only Operator Run Notebooks With Preserved Standing Context

## Status

- plan-ready

## Goal

Make the operator's instance-local notebook durable across long-running campaigns by separating persistent standing guidance from per-cycle wake-up notes and by making ordinary wake-up history append-only instead of mutable latest-state prose.

The intended outcome of this slice is:

1. standing queue and release guidance survives repeated operator wake-ups
2. each wake-up leaves a timestamped journal entry instead of replacing prior notes
3. the operator prompt and loop read the protected standing context plus recent journal history at the start of every cycle
4. the selected instance's operator notebook stays local/generated under `.ralph/instances/<instance-key>/` and remains auditable

## Scope

This slice covers:

1. an explicit operator notebook storage contract under the selected instance's operator-state root
2. path and environment wiring so the operator loop exposes standing-context and wake-up-log notebook surfaces separately
3. initialization and compatibility behavior for the new notebook files in the checked-in operator loop
4. prompt, skill, and runbook updates so wake-up cycles append journal entries and treat standing context as intentional operator-maintained state
5. focused unit and integration tests for notebook-path derivation, append-only log preservation, and standing-context protection

## Non-Goals

This slice does not include:

1. orchestrator retry, reconciliation, dispatch, or handoff-state changes
2. tracker transport, normalization, or review/landing policy refactors
3. report-review-state redesign beyond updating the operator notebook instructions that mention it
4. automatic notebook compaction, summarization, or retention policy beyond preserving append-only history by default
5. a general-purpose operator knowledge base or new persisted state outside the selected instance's `.ralph/instances/<instance-key>/` tree

## Current Gaps

Today the checked-in operator notebook behaves like one mutable scratch document:

1. `deriveOperatorInstanceStatePaths()` exposes only `operator-scratchpad.md`, so there is no typed distinction between standing guidance and per-cycle notes
2. `operator-loop.sh` creates a single scratchpad file and exports only `SYMPHONY_OPERATOR_SCRATCHPAD`
3. the operator prompt instructs the agent to read and update that single file, which makes "latest notes near the top" the de facto state model
4. the operator skill and runbook describe the scratchpad as the durable notebook without structurally protecting standing context from ordinary wake-up churn
5. existing tests prove instance isolation, but they do not lock an append-only journal contract or preserved standing guidance across multiple wake-ups

## Decision Notes

1. Prefer two explicit notebook files over one mixed markdown document with soft section conventions. Separate files make the protection boundary obvious, easier to test, and harder for later prompt edits to erode accidentally.
2. Keep the notebook model operator-local and instance-scoped under `.ralph/instances/<instance-key>/`; this is durable local operator state, not orchestrator runtime truth.
3. Keep the implementation seam narrow by updating only operator notebook contracts, prompt/skill/docs, and their tests. Do not fold tracker or orchestrator changes into this PR.
4. Preserve a small compatibility bridge for the existing `operator-scratchpad.md` path only if needed to avoid breaking adjacent code/tests during migration; do not keep it as the primary contract.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the repo-owned rule that standing operator guidance is updated intentionally and not rewritten each wake-up
2. the rule that wake-up notes are append-only journal entries unless a separate maintenance flow explicitly compacts them
3. the rule that each wake-up reads standing context plus recent journal history before acting

Does not belong here:

1. shell path derivation
2. ad hoc prompt-only state conventions with no checked-in contract
3. tracker lifecycle behavior

### Configuration Layer

Belongs here:

1. typed derivation of operator notebook paths for the selected instance
2. any exported environment variables that identify the standing-context and wake-up-log files
3. compatibility handling for legacy scratchpad path resolution, if kept temporarily

Does not belong here:

1. tracker queries
2. journal-entry formatting logic embedded in unrelated orchestrator code
3. policy hidden only inside the operator model prompt

### Coordination Layer

Belongs here:

1. no orchestrator-runtime changes in this slice
2. at most, an operator-owned notebook state model kept outside orchestrator runtime state

Does not belong here:

1. dispatch, retry, reconciliation, or lease changes
2. repurposing orchestrator counters or issue lifecycle state for notebook persistence

### Execution Layer

Belongs here:

1. operator-loop initialization of the selected instance's notebook files
2. shell environment wiring that passes notebook paths into the operator command
3. append-only journal updates performed through the operator loop contract

Does not belong here:

1. runner behavior changes
2. workspace lifecycle changes
3. provider-specific assumptions about Codex or Claude behavior

### Integration Layer

Belongs here:

1. none beyond the operator shell boundary that passes notebook paths into the selected command
2. keeping tracker/report references in notebook docs at the edge rather than in notebook path helpers

Does not belong here:

1. tracker transport or normalization changes
2. mixing GitHub-specific policy into notebook storage helpers

### Observability Layer

Belongs here:

1. the operator notebook as local/auditable generated state
2. status metadata that points operators to the current standing-context and wake-up-log locations
3. tests and docs that make the append-only journal contract visible and inspectable

Does not belong here:

1. turning the notebook into runtime source of truth for issue state
2. tracker writes embedded in notebook formatting
3. hidden compaction or destructive rewriting of prior wake-up history

## Architecture Boundaries

### `src/domain/instance-identity.ts`

Owns:

1. typed derivation of notebook-related paths for the selected operator instance
2. naming the explicit standing-context and wake-up-log files

Does not own:

1. notebook content rules
2. shell file creation
3. tracker-specific policy

### `skills/symphony-operator/operator-loop.sh`

Owns:

1. creating notebook files when missing
2. exporting the selected notebook paths to the operator command
3. exposing notebook locations in operator-loop status output

Does not own:

1. the only statement of notebook policy
2. tracker review or queue policy changes
3. free-form notebook rewriting logic outside the explicit contract

### `skills/symphony-operator/operator-prompt.md` and `skills/symphony-operator/SKILL.md`

Owns:

1. the behavior contract that the operator must read standing context and append a journal entry per wake-up
2. the distinction between durable standing guidance and transient cycle observations

Does not own:

1. filesystem path derivation
2. the only durable storage definition
3. hidden migration rules

### `docs/guides/operator-runbook.md` and `docs/guides/self-hosting-loop.md`

Owns:

1. canonical operator procedure and notebook interpretation
2. operator-facing explanation of where standing context and wake-up history live

Does not own:

1. typed path derivation
2. notebook write implementation
3. tracker/runtime behavior unrelated to notebook durability

## Slice Strategy And PR Seam

This should fit in one reviewable PR by staying on one narrow operator-notebook seam:

1. add explicit standing-context and wake-up-log paths under the existing instance-scoped operator-state root
2. update the operator loop to initialize and expose those files
3. update the operator prompt/skill/runbook to require append-only wake-up logging and preserved standing guidance
4. add focused tests for notebook-path derivation and multi-cycle persistence behavior

Deferred from this PR:

1. automated notebook compaction or archival tooling
2. richer notebook rendering or search UX
3. tracker-driven operator memory or release-planning automation
4. any orchestrator-owned use of notebook contents

Why this seam is reviewable:

1. it stays entirely on operator-local notebook contracts
2. it does not mix tracker, orchestrator, and runner refactors into the same patch
3. it yields a user-visible durability improvement with small, explicit state surfaces

## Operator Notebook State Model

This issue does not change the orchestrator runtime state machine, but it does introduce an explicit operator-owned notebook model for long-lived local context.

### Notebook surfaces

1. `standing-context.md`
   - durable operator instructions for the selected instance
   - release sequencing, queue policy, known invariants, campaign notes, and temporary workarounds
2. `wake-up-log.md`
   - append-only timestamped wake-up entries
   - each entry records what the operator observed, decided, and queued during that cycle

### States

1. `uninitialized`
   - notebook files do not yet exist for the selected instance
2. `initialized`
   - standing-context and wake-up-log files exist with starter scaffolding
3. `standing-context-maintained`
   - durable guidance has been edited intentionally and remains available for later cycles
4. `wake-up-appended`
   - a cycle has added a new journal entry without deleting prior entries
5. `compatibility-migrated`
   - any legacy scratchpad content that must be preserved has been copied or linked into the new structure

### Allowed transitions

1. `uninitialized -> initialized`
2. `initialized -> standing-context-maintained`
3. `initialized -> wake-up-appended`
4. `standing-context-maintained -> wake-up-appended`
5. `wake-up-appended -> wake-up-appended`
6. `initialized -> compatibility-migrated`
7. `compatibility-migrated -> standing-context-maintained`
8. `compatibility-migrated -> wake-up-appended`

### Contract rules

1. ordinary wake-up cycles may append to `wake-up-log.md` but must not overwrite prior entries
2. ordinary wake-up cycles may read `standing-context.md` but should only edit it intentionally when durable guidance changes
3. notebook history remains local/generated under the selected instance state root
4. status surfaces and docs should expose both notebook paths clearly enough for operators to inspect them directly

## Failure-Class Matrix

| Observed condition                                                      | Local facts available                                            | Notebook facts available                                | Expected decision                                                                 |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| First operator wake-up for a selected instance                          | operator-state root exists or can be created                     | no notebook files                                       | initialize `standing-context.md` and `wake-up-log.md` with starter scaffolding    |
| Existing standing guidance plus a new wake-up cycle                     | notebook files exist                                             | standing context present, prior wake-up history present | read both files, preserve standing context, append one new timestamped log entry  |
| Existing legacy `operator-scratchpad.md` but no new notebook files      | legacy scratchpad present                                        | new files absent                                        | preserve the prior notes through a compatibility migration path, then use new files |
| Operator appends a new wake-up entry after many prior cycles            | existing `wake-up-log.md`                                        | prior entries present                                   | add a new entry at the end; do not truncate or rewrite older entries              |
| Standing guidance changes intentionally during a campaign               | operator edits standing-context file                             | wake-up history remains intact                          | update only standing context; keep append-only wake-up history unchanged           |
| Journal file is missing or corrupted but standing context still exists  | standing file readable, log missing or malformed                 | partial notebook state                                  | recreate/repair the wake-up log scaffold without discarding standing context       |

## Storage / Persistence Contract

Operator-local notebook state remains under the selected operator instance root:

1. `<operator-repo-root>/.ralph/instances/<instance-key>/standing-context.md`
2. `<operator-repo-root>/.ralph/instances/<instance-key>/wake-up-log.md`
3. optionally, a compatibility artifact for legacy `operator-scratchpad.md` only if required during migration

Status output should continue to expose the operator-state root and should also surface the standing-context and wake-up-log paths explicitly.

The notebook is local/generated operator state, not tracker truth and not orchestrator runtime truth.

## Observability Requirements

1. operator-loop status JSON/Markdown should point to the explicit notebook files, not only a generic scratchpad path
2. starter scaffolding should make the standing-context versus wake-up-log distinction obvious when an operator opens the files directly
3. docs should describe the notebook contract in operator-facing terms and call out the append-only wake-up-log rule

## Implementation Steps

1. Extend the operator instance-state path contract to derive explicit standing-context and wake-up-log paths, plus any temporary legacy compatibility path that is needed.
2. Refactor `bin/resolve-operator-instance.ts` and `skills/symphony-operator/operator-loop.sh` to expose those paths and initialize the files with clear starter headings when missing.
3. Update the operator prompt so each cycle:
   - reads standing context first,
   - reads the recent wake-up log context needed for continuity,
   - appends a new timestamped journal entry instead of rewriting notebook history,
   - and edits standing context only when durable guidance truly changes.
4. Update the operator skill, runbook, README/self-hosting docs as needed so the checked-in operator contract matches the new notebook model.
5. Add tests for:
   - notebook path derivation
   - loop initialization of the new files
   - append-only preservation across multiple operator-loop cycles
   - standing-context preservation when later cycles add wake-up notes

## Tests And Acceptance Scenarios

1. unit: `deriveOperatorInstanceStatePaths()` returns explicit standing-context and wake-up-log paths under `.ralph/instances/<instance-key>/`
2. integration: one operator-loop run initializes both notebook files with the expected headings and status metadata
3. integration: a second operator-loop run appends to the wake-up log without removing the first entry
4. integration: standing-context edits made before a later cycle remain present after the next cycle runs
5. contract: operator prompt/skill/runbook text directs the operator to use standing context plus append-only wake-up logging
6. repo gate: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test`

Named acceptance scenarios:

1. A long-running release campaign keeps "after SPIKE-001, queue FEAT-001" in standing context while later wake-up entries accumulate separately.
2. Two later wake-up cycles preserve the earlier journal history in order instead of replacing it with the latest status summary.
3. An instance with existing legacy scratchpad content is migrated without silently discarding prior operator notes.

## Exit Criteria

1. the operator notebook model has explicit standing-context and append-only wake-up-log storage for each selected instance
2. checked-in operator instructions require reading both notebook layers and appending wake-up entries
3. standing guidance survives later wake-up cycles in tests
4. operator-loop status surfaces and docs point operators at the correct notebook files
5. formatting, lint, typecheck, and test gates pass for the implementation PR

## Deferred Work

1. automated notebook compaction or summarization flows
2. notebook search/indexing features
3. turning notebook content into scheduler/orchestrator inputs
4. any broader operator memory or campaign-planning system beyond the local notebook seam

## Revision Log

- 2026-03-29: Initial plan written for human review.
