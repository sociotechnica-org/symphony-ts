# Issue 296 Plan: Operator CLI Harness Flags And Resumable Session Mode

## Status

- plan-ready

## Goal

Make the repo-owned operator loop easier to run and cheaper to iterate on by replacing most routine `SYMPHONY_OPERATOR_COMMAND` hand-authoring with first-class CLI flags for harness/model selection, while adding an instance-scoped resumable operator-session mode that can reuse a compatible backend session across wake-up cycles.

The intended outcome of this slice is:

1. operators can choose Codex or Claude plus an explicit model from `pnpm operator` / `operator-loop.sh` flags
2. `SYMPHONY_OPERATOR_COMMAND` remains available as an escape hatch, but the normal path is explicit and inspectable
3. an optional infinite-session mode can reuse one compatible provider session across wake-ups instead of cold-starting every cycle
4. operator status artifacts make the selected harness, effective command, and session mode/state obvious
5. the change stays on the operator-local tooling seam and does not reopen factory runtime, tracker, or worker-runner contracts

## Scope

This slice covers:

1. operator-loop flag parsing for harness/provider selection, model selection, raw command override, and resumable-session mode
2. a typed command-resolution helper that turns those flags plus existing environment fallbacks into one effective operator command
3. an instance-scoped persisted operator-session record under `.ralph/instances/<instance-key>/` for resumable mode
4. provider-specific resume-command reconstruction for the supported operator harnesses
5. operator-loop status JSON/Markdown updates so the chosen provider/model, command source, and session posture are visible
6. focused tests for flag precedence, command building, persisted-session compatibility/reset behavior, and loop integration
7. README / runbook / self-hosting / skill updates for the new operator UX and the reset semantics of resumed sessions

## Non-Goals

This slice does not include:

1. changing `WORKFLOW.md` worker runner selection or any factory worker model selection behavior
2. changing tracker transport, normalization, handoff policy, CI/review policy, or landing policy
3. moving the operator loop into the product `symphony` CLI
4. removing `SYMPHONY_OPERATOR_COMMAND` or forbidding fully custom commands
5. building a general multi-provider session protocol beyond the providers the repo can reconstruct safely today
6. introducing background multi-session pooling, multiple resumable sessions per instance, or cross-instance session sharing
7. broad orchestration/runtime changes outside the operator-local wake-up loop

## Current Gaps

Today the checked-in operator loop is too opaque for routine selection and too stateless for cheap repeated wake-ups:

1. `skills/symphony-operator/operator-loop.sh` exposes only `--once`, `--interval-seconds`, and `--workflow`; harness and model changes require rewriting a raw command string
2. the default command is Codex-specific, but the repo documentation also supports Claude, so the normal operator UX is less provider-neutral than the surrounding runtime model
3. status artifacts record only the final raw `command` string, which hides whether it came from defaults, CLI flags, or an explicit escape hatch
4. the loop does not keep any provider session identity between wake-ups, so each cycle cold-starts a fresh operator conversation
5. there is no typed instance-local storage contract for operator session reuse analogous to existing instance-local notebook and release-state artifacts
6. command-building and session-resume rules currently live only in adjacent runner helpers for factory workers, not in operator-loop-specific tooling

## Decision Notes

1. Keep the shell script thin. Complex flag validation, provider-specific command construction, and persisted-session compatibility logic should move into focused checked-in TypeScript helpers instead of expanding shell-only branching.
2. Keep the seam operator-local. This issue should not thread operator harness selection into `WORKFLOW.md`, runner factory wiring, or orchestrator state.
3. Reuse existing command-shape knowledge where possible. Codex and Claude already have checked-in command parsing / resume helpers; the operator loop should build on those conventions rather than inventing unrelated flag semantics.
4. Treat persisted operator session state as local operator tooling state, not runtime source of truth. Standing context, wake-up log, release state, and tracker artifacts remain the system of record for work state.
5. Keep backward compatibility explicit. Existing `SYMPHONY_OPERATOR_COMMAND` workflows must keep working, and default behavior without new flags must remain a fresh-command loop.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses `docs/architecture.md`.

### Policy Layer

Belongs here:

1. the repo-owned rule that routine operator harness/model selection should be explicit and inspectable instead of hidden in one opaque environment string
2. the rule that resumable operator sessions are optional, instance-scoped, and compatibility-checked before reuse
3. the rule that a stored operator session is a convenience artifact only; it does not replace standing context, wake-up history, release state, or tracker facts

Does not belong here:

1. provider-specific shell tokenization or resume-command reconstruction
2. tracker lifecycle changes
3. worker-runner policy in `WORKFLOW.md`

### Configuration Layer

Belongs here:

1. typed parsing of operator-loop flags and environment fallbacks
2. precedence rules between `--provider` / `--model` / `--operator-command` and `SYMPHONY_OPERATOR_COMMAND`
3. typed derivation of the persisted operator-session state path and command fingerprint inputs

Does not belong here:

1. tracker reads
2. shell log scraping embedded inline in the bash loop
3. factory worker config changes

### Coordination Layer

Belongs here:

1. the operator-loop-local session reuse policy for one selected instance
2. explicit transitions between fresh run, resumable run, incompatible-stored-session reset, and cleared session state after failure
3. keeping the operator loop’s outer cycle state and inner session state distinguishable

Does not belong here:

1. factory dispatch, retry, reconciliation, or lease logic
2. reusing orchestrator counters or issue lifecycle state as operator-session state
3. tracker-specific handoff decisions

### Execution Layer

Belongs here:

1. the concrete effective command executed for each wake-up cycle
2. provider-specific resume-command reconstruction for supported harnesses
3. capture and persistence of resumable backend session ids when available

Does not belong here:

1. worker runner changes
2. workspace lifecycle changes
3. tracker mutation logic

### Integration Layer

Belongs here:

1. thin provider-specific command-compatibility rules at the operator boundary
2. safe use of existing Codex and Claude command conventions for resume behavior

Does not belong here:

1. tracker transport or normalization work
2. GitHub-specific operator policy mixed into command resolution
3. assuming every custom raw command supports reusable sessions

### Observability Layer

Belongs here:

1. operator status JSON/Markdown fields that expose provider, model, command source, session mode, and persisted session state path/summary
2. the instance-scoped persisted operator-session artifact under `.ralph/instances/<instance-key>/`
3. docs and tests that make reset and compatibility behavior inspectable

Does not belong here:

1. treating status artifacts as the only source of session truth
2. hiding resume/reset decisions only inside logs
3. factory runtime status redesign outside the operator loop

## Architecture Boundaries

### `skills/symphony-operator/operator-loop.sh`

Owns:

1. user-facing shell entry-point parsing and forwarding of operator-loop arguments
2. invocation of focused TypeScript helpers for command/session resolution where needed
3. publishing the final resolved operator status plus running the effective command

Does not own:

1. large provider-specific command-building branches
2. the only definition of persisted operator-session compatibility
3. worker-runner semantics

### `src/domain/instance-identity.ts`

Owns:

1. derivation of the new operator-session state path under the selected instance root
2. naming the operator-local persistence artifact alongside existing notebook/release artifacts

Does not own:

1. session content or reset policy
2. provider-specific resume logic
3. shell execution

### New focused operator helper module(s)

Owns:

1. typed operator-loop option parsing / normalization
2. effective-command construction for supported providers and the raw-command escape hatch
3. command fingerprinting, persisted-session compatibility checks, and provider-specific resume-command reconstruction
4. extraction / persistence of resumable backend session ids where the supported provider exposes them

Does not own:

1. tracker reads or writes
2. notebook content rules
3. factory worker runner selection

### `skills/symphony-operator/SKILL.md`, `operator-prompt.md`, `docs/guides/operator-runbook.md`, `docs/guides/self-hosting-loop.md`, and `README.md`

Owns:

1. the operator-facing contract for the new flags
2. the distinction between fresh-command mode and resumable-session mode
3. documentation of when stored sessions are reused versus reset

Does not own:

1. hidden precedence rules that are not backed by code/tests
2. the only persistence definition
3. tracker/runtime semantics unrelated to the operator loop

## Slice Strategy And PR Seam

This should fit in one reviewable PR by staying on one narrow operator-tooling seam:

1. add typed harness/model/raw-command flag support for the checked-in operator loop
2. add one instance-scoped persisted operator-session artifact plus compatibility/reset logic
3. expose the resolved mode through operator status/docs/tests

Deferred from this PR:

1. user-tunable session reset budgets or compaction policies beyond the minimum documented reset behavior in this slice
2. more provider integrations beyond the supported operator harnesses and raw-command passthrough
3. product-CLI promotion of the operator loop
4. any worker-runner or orchestrator runtime changes

Why this seam is reviewable:

1. it stays in operator-local tooling, docs, and tests
2. it avoids mixing tracker, worker-runner, and orchestrator code into the same review surface
3. it yields a concrete operator-facing improvement without reopening the factory core

## Operator Session State Model

This issue does not change the factory runtime state machine, but resumable operator sessions add explicit operator-local state that must be named separately from the outer wake-up loop.

### Session modes

1. `disabled`
   - default behavior; no persisted operator session is consulted or written
2. `fresh`
   - resumable mode is enabled, but no compatible persisted backend session is available for this cycle
3. `resuming`
   - resumable mode is enabled and a compatible stored session id is used to build the effective resume command
4. `reset-required`
   - resumable mode is enabled, but the stored session must be cleared before the next run because it is incompatible, unreadable, unsupported for the selected command, or was invalidated by a failed resume path

### Stored session record

The persisted artifact should record only the facts needed to decide reuse safely:

1. selected provider
2. resolved base command fingerprint
3. selected model, when applicable
4. stored backend session id
5. timestamps for creation and most recent use
6. last known mode/decision summary

### Allowed transitions

1. `disabled -> fresh`
   - operator enables resumable mode
2. `fresh -> resuming`
   - a successful fresh run captures a backend session id that can be reused later
3. `resuming -> resuming`
   - a resume run succeeds and keeps the stored session compatible
4. `resuming -> reset-required`
   - resume fails, stored session cannot be parsed, or the selected command/provider/model changed incompatibly
5. `reset-required -> fresh`
   - the loop clears the incompatible record and starts a new session on the next wake-up
6. `fresh -> disabled`
   - resumable mode is turned off
7. `resuming -> disabled`
   - resumable mode is turned off and the stored record is ignored or cleared per the documented behavior

### Notes

1. The outer operator-loop status states such as `sleeping`, `acting`, and `retrying` remain unchanged; session mode is additional operator-local state, not a replacement for those coarse loop states.
2. Compatibility must be strict enough that changing provider, model, or explicit raw command does not silently resume the wrong conversation.
3. This slice’s reset policy is minimum and explicit: incompatible or failed stored sessions are cleared and replaced by a fresh session on a later wake-up. Smarter periodic resets can be deferred if they would broaden the seam.

## Failure-Class Matrix

| Observed condition                                                                                                | Local facts available                             | Expected decision                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Operator runs with no new flags and no `SYMPHONY_OPERATOR_COMMAND` override                                       | loop argv, default settings                       | keep today’s fresh default command behavior                                                               |
| Operator selects `--provider codex --model gpt-5.4-mini`                                                          | parsed loop flags                                 | build the documented Codex operator command with the requested model and publish provider/model in status |
| Operator selects `--provider claude` without a model                                                              | parsed loop flags                                 | build the documented Claude headless command, letting model remain omitted/default unless explicitly set  |
| Operator passes `--operator-command <raw>`                                                                        | parsed loop flags                                 | use the raw command as the effective command and preserve it as the escape hatch path                     |
| Resumable mode is enabled but no stored session file exists                                                       | instance-scoped session state path                | run fresh, then attempt to capture/store a resumable backend session id if the provider exposes one       |
| Stored session exists but provider/model/base command fingerprint changed                                         | stored record plus current resolved command facts | clear or ignore the stale record and run fresh; do not attempt resume                                     |
| Stored session exists but selected provider does not support safe resume reconstruction for the effective command | stored record plus provider kind                  | treat as `reset-required` or `fresh`; do not guess a resume command                                       |
| Resume attempt fails or returns no reusable session id                                                            | process exit/output plus stored record            | clear the stored record, surface the reset in status/logs, and fall back to fresh mode on a later cycle   |
| Stored session artifact is unreadable or malformed                                                                | persisted session file                            | clear/replace it and continue with a fresh run instead of wedging the loop                                |

## Storage And Persistence Contract

Versioned:

1. operator-loop code, docs, and tests
2. typed helpers for operator command/session resolution

Local/generated under `.ralph/instances/<instance-key>/`:

1. `standing-context.md`
2. `wake-up-log.md`
3. `release-state.json`
4. `report-review-state.json`
5. new operator-session state artifact for resumable mode
6. existing status/log/lock artifacts

Rules:

1. the persisted session artifact is instance-scoped and must never be shared across instance keys
2. the artifact is convenience state only; if it is missing, stale, or unreadable, the loop must remain operable in fresh mode
3. status output should point to the session-state artifact when resumable mode is selected

## Observability Requirements

1. operator status JSON/Markdown should expose the selected provider, selected model, resolved command source, and effective command
2. status should show whether the current cycle used fresh or resumable session mode
3. status should surface a concise session summary or reset reason when resumable mode is enabled
4. logs should make fresh-versus-resume decisions inspectable without requiring raw shell archaeology
5. docs should explain how operators intentionally switch providers/models and what causes an automatic session reset

## Implementation Steps

1. Add `docs/plans/296-operator-cli-harness-and-session-flags/plan.md`.
2. Extend the operator instance-state path contract with a dedicated persisted session-state path.
3. Add a focused TypeScript helper for operator-loop option normalization and effective command resolution, including precedence rules for new flags versus `SYMPHONY_OPERATOR_COMMAND`.
4. Add focused persisted-session helpers for command fingerprinting, compatibility checks, stored-session loading/saving, and provider-specific resume-command reconstruction.
5. Update `skills/symphony-operator/operator-loop.sh` to:
   - parse and validate the new flags
   - resolve the effective command through the helper
   - load or clear persisted session state as needed
   - record the richer status fields
   - persist any resumable backend session id after successful cycles
6. Reuse or adapt existing Codex and Claude command conventions so supported operator harnesses have explicit default command templates and safe resume behavior.
7. Add or update tests for command resolution, persisted-session state transitions, and operator-loop integration.
8. Update README, operator skill, runbook, and self-hosting docs with the new commands and reset semantics.
9. Run local QA, self-review the diff, and open/update the PR for `#296`.

## Tests And Acceptance Scenarios

### Unit tests

1. operator command resolution builds the expected Codex default, Codex-with-model, and Claude default commands
2. `--operator-command` and `SYMPHONY_OPERATOR_COMMAND` precedence remains explicit and backward compatible
3. persisted-session compatibility rejects provider/model/base-command mismatches
4. persisted-session loading tolerates missing or malformed files by falling back to fresh mode
5. provider-specific resume-command reconstruction forwards only supported flags

### Integration tests

1. invoking `operator-loop.sh --once --provider codex --model ...` publishes the resolved provider/model/command fields in status artifacts
2. invoking `operator-loop.sh --once --provider claude` publishes the Claude provider selection cleanly
3. enabling resumable mode across two operator cycles for a supported provider reuses the stored backend session id on the second cycle
4. changing provider/model/raw command between cycles invalidates the stored session and forces a fresh cycle
5. a bad stored session artifact or failed resume path does not wedge the loop; the next cycle can proceed fresh

### End-to-end seam statement

This issue stays entirely on the checked-in operator loop. The end-to-end slice for this seam is the integration path that invokes the real shell entry point with fake provider commands and inspects the generated instance-scoped operator artifacts.

### Acceptance scenarios

1. `pnpm operator -- --provider codex --model gpt-5.4-mini` runs without requiring a hand-authored raw operator command.
2. `pnpm operator -- --provider claude` switches the operator harness without editing the script or exporting a custom command.
3. `pnpm operator -- --provider codex --model gpt-5.4-mini --infinite-session` reuses a compatible stored session on later wake-ups when the provider supports resume.
4. operator status artifacts make it obvious whether the cycle used a fresh or resumed session and what effective command was selected.
5. existing raw-command usage remains available for unsupported/custom operator commands.

## Exit Criteria

1. the checked-in operator loop supports explicit provider/model/raw-command selection with documented precedence rules
2. the loop exposes an opt-in resumable session mode with instance-scoped persisted session state
3. status artifacts clearly surface the selected harness/model/command and fresh-versus-resume posture
4. docs explain the supported operator UX and reset semantics
5. local QA passes and the PR stays limited to operator-local tooling/doc/test changes

## Deferred

1. product-CLI promotion of the operator loop
2. user-configurable session rotation budgets or richer compaction policies
3. multi-session pooling or concurrent operator conversations per instance
4. support for arbitrary custom raw commands to participate in resumable mode without provider-specific helpers
5. any factory worker or orchestrator behavior changes
