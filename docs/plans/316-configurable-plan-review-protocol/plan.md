# Issue 316 Plan: Configurable Plan-Review Protocol Per Workflow

## Status

- plan-ready

## Goal

Make the plan-review handoff protocol workflow-configurable so repositories can define their own plan-ready marker, review-decision markers, plan-ready metadata fields, and operator reply guidance while preserving the current Symphony protocol as the default for repositories that do not override anything.

## Scope

1. add a workflow-owned tracker config surface for plan-review protocol settings on GitHub-backed trackers, with default behavior matching today's Symphony protocol
2. move hard-coded plan-review parsing/formatting rules behind a focused protocol contract instead of fixed string literals in helper modules
3. make tracker-side plan-review detection use the resolved protocol instead of only the built-in markers
4. make plan-ready comment formatting use the resolved protocol, including configurable metadata labels and reply-template guidance
5. update operator-facing guidance so it reads and follows the configured protocol rather than assuming only the default Symphony strings
6. update workflow docs, frontmatter reference, starter template, and tests so default behavior stays unchanged and at least one overridden protocol is covered end to end

## Non-goals

1. changing the meaning of the existing normalized handoff lifecycle kinds such as `awaiting-human-handoff` or `missing-target`
2. redesigning pull-request review, landing, or general handoff lifecycle semantics
3. moving tracker policy into the orchestrator or making the orchestrator parse raw tracker comments
4. inventing a tracker-neutral human-review product beyond the existing issue-comment and ticket-comment surfaces
5. changing the repo-owned requirement that `symphony-ts` itself uses the documented plan-review station before substantial implementation unless waived

## Current Gaps

1. `src/tracker/plan-review-signal.ts` hard-codes the accepted `plan-ready`, `approved`, `changes-requested`, and `waived` first-line markers
2. `src/tracker/plan-review-comment.ts` hard-codes the default metadata labels, reply templates, and guidance text for plan-ready comments
3. `src/tracker/plan-review-policy.ts` hard-codes acknowledgement text that refers to the default plan-ready marker rather than a repository-owned protocol
4. `src/tracker/linear-policy.ts` reuses the same hard-coded signal parser, so repositories using non-default review markers cannot participate cleanly there either
5. `skills/symphony-operator/SKILL.md` and `skills/symphony-operator/operator-prompt.md` assume the default Symphony markers instead of a workflow-owned protocol
6. `docs/guides/workflow-frontmatter-reference.md` and current tracker config types expose no plan-review protocol override seam

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction-level mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: the repository-owned choice of plan-ready marker, review-decision markers, required metadata labels, and operator reply guidance
  - does not belong: GitHub or Linear comment transport details, raw API payload handling, or orchestration transitions
- Configuration Layer
  - belongs: typed workflow config for the plan-review protocol, validation/defaulting, and prompt-visible resolved config
  - does not belong: evaluating issue comments or deciding whether a handoff is waiting or resumable
- Coordination Layer
  - belongs: no state-machine changes beyond continuing to consume normalized handoff lifecycle results
  - does not belong: parsing configurable plan-review markers or metadata labels
- Execution Layer
  - belongs: worker/operator guidance that tells humans and agents which configured protocol to emit or review
  - does not belong: tracker comment parsing or GitHub URL construction scattered through prompts
- Integration Layer
  - belongs: plan-review protocol parsing/formatting helpers, tracker-edge policy evaluation, and tracker-specific comment handling for GitHub and Linear
  - does not belong: prompt-policy rules hidden only in skill text with no workflow/config contract
- Observability Layer
  - belongs: preserving clear issue-thread and operator-facing summaries when default or overridden protocols are used
  - does not belong: introducing a new dashboard or runtime state model for this slice

## Architecture Boundaries

### Belongs in this issue

1. `src/domain/workflow.ts` and `src/config/workflow.ts`
   - add a typed plan-review protocol config object
   - default it to the current Symphony protocol
   - validate metadata-label and review-marker configuration cleanly at the boundary
2. focused tracker-edge helpers
   - extract a resolved plan-review protocol model separate from GitHub/Linear transport
   - make signal parsing, plan-ready formatting, metadata parsing, and acknowledgement text consume that model
3. GitHub and Linear tracker policy call sites
   - thread the resolved protocol into policy evaluation without changing normalized lifecycle meanings
4. prompt/docs/operator guidance
   - update self-hosting workflow text, third-party template text, operator skill text, and workflow docs to describe the configured protocol source of truth
5. tests
   - unit coverage for default and overridden protocol parsing/formatting
   - integration coverage that overridden markers still map into the same normalized lifecycle
   - workflow-config coverage for parsing/defaulting the new config object

### Does not belong in this issue

1. orchestrator branching on configurable raw tracker markers
2. broad refactors to PR review, landing command, or reviewer-app policy
3. a new durable operator config store outside `WORKFLOW.md`
4. moving repo-owned review requirements from `WORKFLOW.md` and `AGENTS.md` into hidden skill-only logic
5. unrelated tracker transport rewrites for GitHub or Linear

## Layering Notes

- `config/workflow`
  - owns the parsed plan-review protocol contract and defaults
  - does not own tracker comment interpretation
- `tracker`
  - owns signal parsing, comment formatting, metadata parsing, and lifecycle evaluation against the configured protocol
  - does not leak raw configurable strings into orchestrator branches
- `workspace`
  - remains unchanged
  - does not participate in plan-review protocol parsing
- `runner`
  - remains unchanged
  - does not infer review protocol from runner behavior
- `orchestrator`
  - continues to consume normalized lifecycle kinds such as `awaiting-human-handoff`
  - does not know which first-line marker the repository chose
- `observability`
  - preserves lifecycle summaries and human-readable traces
  - does not become the source of truth for the protocol itself

## Slice Strategy And PR Seam

This issue should land as one reviewable PR with one explicit seam: move the plan-review protocol from hard-coded tracker/operator assumptions into typed workflow configuration while preserving today's protocol as the default implementation.

This stays reviewable because it deliberately limits the change to:

1. one new config surface
2. one focused tracker-edge protocol helper seam
3. narrow call-site updates in GitHub, Linear, and operator/prompt guidance
4. targeted tests for default and overridden protocols

This issue should not expand into lifecycle redesign, orchestrator recovery changes, or a broader tracker-abstraction refactor.

## Runtime State Model

This issue preserves the existing normalized handoff lifecycle states. The only thing that changes is how tracker comments are recognized and formatted before they map into those existing states.

### States in play

1. `missing-target`
2. `awaiting-human-handoff`
3. decision comments that resume work: configured equivalents of `approved`, `changes-requested`, and `waived`

### Allowed transitions relevant here

1. configured plan-ready comment detected and no PR exists -> `awaiting-human-handoff`
2. configured approval marker detected after a prior plan-ready comment -> `missing-target` with resume summary
3. configured waiver marker detected after a prior plan-ready comment -> `missing-target` with resume summary
4. configured changes-requested marker detected after a prior plan-ready comment -> `missing-target` with revise summary
5. a fresh configured plan-ready comment after prior changes-requested feedback -> back to `awaiting-human-handoff`

### Explicit non-transitions

1. this issue must not add a new orchestration state for "custom protocol loaded"
2. this issue must not change the existing meanings of `awaiting-human-handoff` or `handoff-ready`

## Failure-Class Matrix

| Observed condition                                                                                               | Local facts available                     | Normalized tracker/config facts available                                              | Expected decision                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository omits plan-review protocol config entirely                                                            | workflow has only existing tracker fields | resolved tracker config defaults to Symphony protocol                                  | preserve current behavior exactly                                                                                                                                          |
| Repository configures custom markers but leaves metadata-label overrides omitted                                 | workflow contains partial override        | resolved protocol merges custom markers with default metadata labels/template defaults | accept configured markers and keep default metadata shape where not overridden                                                                                             |
| Worker posts a custom plan-ready first line that matches workflow config                                         | no PR yet                                 | configured parser recognizes custom plan-ready marker                                  | enter `awaiting-human-handoff`                                                                                                                                             |
| Human posts a default Symphony approval marker on a repo that configured a different approval marker             | no PR yet                                 | configured parser does not recognize the default marker                                | no resume transition from that comment; repository-chosen protocol remains authoritative                                                                                   |
| Human posts a configured approval/waiver/changes-requested marker without any prior recognized plan-ready anchor | no PR yet                                 | configured decision marker exists, but no anchored plan-ready comment exists           | ignore as unanchored review decision, same as today                                                                                                                        |
| Custom plan-ready metadata omits one of the repository-required labels                                           | plan-ready comment exists                 | signal is valid but metadata parse is incomplete under configured required labels      | waiting-state detection should still work if the configured first-line marker is valid; metadata helper/report parsing remains null/incomplete instead of inventing fields |
| Operator guidance still assumes default strings while workflow config overrides them                             | workflow has custom protocol              | operator prompt/skill did not read resolved protocol                                   | invalid implementation for this issue; guidance must point back to configured protocol instead of default-only text                                                        |

## Storage / Persistence Contract

1. `WORKFLOW.md` frontmatter becomes the canonical configuration source for plan-review protocol overrides
2. resolved runtime config in memory remains the authoritative typed contract the prompt builder and trackers consume
3. issue comments or ticket comments remain the canonical tracker-side evidence of emitted handoff signals
4. no new durable local storage should be introduced for this slice

## Observability Requirements

1. lifecycle summaries must remain clear regardless of whether the repository uses the default or an overridden protocol
2. plan-ready comment formatting helpers should remain inspectable and testable when metadata labels change
3. operator-facing instructions must make it obvious that the workflow config is the source of truth for the current plan-review protocol

## Implementation Steps

1. add a typed `tracker.plan_review` config surface for GitHub-backed trackers, and if Linear continues to share the same review-marker semantics, reuse the same protocol shape there instead of creating tracker-divergent config objects
2. define a focused protocol model/helper at the tracker edge that covers:
   - plan-ready marker
   - decision markers
   - metadata labels and required metadata keys for plan-ready comments
   - reply-template block and acknowledgement wording derived from the configured markers
3. refactor `src/tracker/plan-review-signal.ts`, `src/tracker/plan-review-comment.ts`, and `src/tracker/plan-review-policy.ts` to consume that protocol model instead of fixed literals
4. thread the resolved protocol through GitHub and Linear plan-review call sites while keeping normalization, policy, and transport separated
5. update workflow-facing docs and templates:
   - `WORKFLOW.md`
   - `README.md`
   - `docs/guides/workflow-guide.md`
   - `docs/guides/workflow-frontmatter-reference.md`
   - `src/templates/third-party-workflow.ts`
6. update operator guidance:
   - `skills/symphony-operator/SKILL.md`
   - `skills/symphony-operator/operator-prompt.md`
     so it references the configured protocol instead of default-only strings
7. add or update tests for:
   - workflow config parsing/defaults
   - default protocol formatting/parsing compatibility
   - at least one overridden protocol across unit/integration coverage
   - operator/planning contract wording where repo-owned docs are the primary deliverable

## Tests And Acceptance Scenarios

### Unit

1. workflow loader resolves the default plan-review protocol when no override is configured
2. workflow loader resolves a custom protocol when markers and metadata labels are overridden
3. plan-review signal parsing recognizes custom configured markers and stops recognizing non-configured ones
4. plan-ready formatter emits custom metadata labels and reply-template text while preserving default output when unconfigured
5. metadata parsing respects configured required labels and returns null when repository-required metadata is missing

### Integration

1. GitHub tracker reports `awaiting-human-handoff` when a custom configured plan-ready marker is posted
2. GitHub tracker resumes correctly on custom configured approval, waiver, and changes-requested markers
3. Linear lifecycle policy continues to map configured markers into the same normalized handoff behavior if Linear remains on the shared protocol path
4. default workflows with no overrides still pass existing plan-review integration scenarios unchanged

### End-to-end

1. a default workflow still performs the current recoverable `plan-ready` handoff unchanged
2. an overridden workflow can post a custom plan-ready comment and the factory waits at `awaiting-human-handoff` instead of failing on missing PR

### Local Gate

1. `pnpm format`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. local self-review if a reliable review command is available

## Exit Criteria

1. workflow config can express the plan-review protocol without changing repository code
2. default workflows preserve today's exact Symphony plan-review behavior
3. tracker parsing uses the resolved protocol rather than only built-in strings
4. plan-ready comment formatting uses the resolved protocol, including metadata labels and reply guidance
5. operator guidance points back to the configured protocol instead of assuming default-only markers
6. tests cover both default behavior and at least one overridden protocol

## Deferred Work

1. broader tracker-neutral workflow stations beyond the current plan-review contract
2. new observability surfaces that render configured protocol details outside prompt/docs/tests
3. runtime enforcement that rejects malformed human comments before tracker inspection
4. any redesign of the landing, PR review, or Beads-native handoff experience

## Decision Notes

1. The protocol should be workflow-owned configuration, not another repo-local hidden prompt convention. That keeps third-party repositories inspectable and lets tracker code consume a typed contract.
2. Preserve one focused protocol helper seam rather than scattering configurable marker strings across GitHub, Linear, docs, tests, and operator assets.
3. The normalized lifecycle contract should remain stable. Repositories may customize the comment protocol, but the orchestrator should still see the same tracker-neutral handoff states.
4. Self-hosting policy remains stricter than generic third-party defaults. `symphony-ts` can continue to require the plan-review station in repo-owned docs while still expressing the protocol through workflow config.

## Revision Log

- 2026-04-01: Initial draft created for issue `#316`; no prior issue-thread plan review comments existed.
