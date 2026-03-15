# Issue 087 Plan: Prompt Trust Boundaries For GitHub Tracker Content

## Status

- plan-ready

## Goal

Define and implement a repo-owned trust policy for tracker-authored content in worker prompts so GitHub issue and review text no longer flows into the worker as raw prompt input, while preserving enough structured task context for implementation and review follow-up.

## Scope

- define a prompt trust model for GitHub issue metadata, issue body, issue comments, pull request lifecycle fields, and automated review feedback
- introduce an explicit prompt-facing context shape that distinguishes trusted verbatim fields from summarized, sanitized, and excluded tracker content
- update the checked-in `WORKFLOW.md` prompt contract and supporting docs to describe that trust boundary explicitly
- cover issue-body and review-feedback handling with unit/integration/e2e tests

## Non-Goals

- changing tracker claim/retry/reconciliation behavior
- adding local mirror sync or wrapper CLIs
- hardening remote execution or runner sandboxes beyond prompt inputs
- redesigning the full workflow prompt beyond the trust-boundary slice
- introducing general comment-sync infrastructure for tracker backends

## Spec Alignment By Abstraction Level

### Policy Layer

- belongs: the repo-owned decision that tracker content in prompts is classified as `trusted`, `summarized`, `sanitized`, or `excluded`
- belongs: the prompt contract in `WORKFLOW.md` and repo docs that tell workers what tracker text they are seeing and what they are not
- does not belong: GitHub REST/GraphQL fetching details or runner subprocess behavior

### Configuration Layer

- belongs: prompt-building inputs and Liquid-visible fields that expose only the approved prompt-facing context
- belongs: documentation and tests for the prompt template contract
- does not belong: raw GitHub payload parsing or pull-request lifecycle policy

### Coordination Layer

- intentionally untouched except for consuming the existing prompt-builder interface
- does not belong: tracker trust classification logic or GitHub-specific text handling

### Execution Layer

- intentionally untouched
- does not belong: prompt trust policy, tracker summarization, or GitHub content parsing

### Integration Layer

- belongs: GitHub-specific normalization/summarization that converts raw issue/review content into the prompt-facing context shape
- belongs: explicit exclusion of GitHub fields that should not cross the tracker-to-prompt trust boundary
- does not belong: workflow template wording or orchestrator retry policy

### Observability Layer

- minimal touch only if prompt-context decisions need lightweight issue-report/status wording for operator clarity
- does not belong: duplicating raw untrusted tracker text into logs or new status surfaces

## Current Gaps

- `WORKFLOW.md` interpolates `{{ issue.description }}` directly into the worker prompt.
- `WORKFLOW.md` interpolates `{{ feedback.body }}` for actionable review feedback directly into the worker prompt.
- prompt rendering currently receives raw `RuntimeIssue` and `HandoffLifecycle` objects, so there is no explicit prompt-facing trust boundary in code.
- GitHub issue comments are not part of the worker prompt today, but that exclusion is implicit rather than a documented policy.
- existing workflow tests prove raw prompt rendering works; they do not prove prompt trust boundaries or malicious-content handling.

## Trust Policy Proposal

### Trusted Verbatim

- issue identifier, number, title, canonical URL, labels, and normalized state
- pull-request URL, branch name, lifecycle kind, summary, pending/failing check names, and actionable feedback counts
- repo-owned workflow instructions and config-derived fields

### Summarized

- issue body: provide a repository-generated plain-text summary optimized for task context, not a raw pass-through
- automated review feedback: provide per-item structured summaries that preserve author, location, URL, and the actionable request in reduced form

### Sanitized

- summary text derived from GitHub-authored markdown should be normalized to plain text, collapse formatting/control sequences, strip prompt-like wrappers, and cap length so tracker-authored text cannot dominate the prompt

### Excluded

- raw issue body markdown/html
- raw issue comments
- raw automated review comment bodies
- non-actionable bot summary comments already ignored by review policy

## Architecture Boundaries

### Workflow / Config

- define a prompt-facing data model such as `PromptIssueContext` / `PromptReviewFeedbackContext`
- keep Liquid rendering limited to that model rather than raw tracker/domain entities
- document the contract in `WORKFLOW.md` and `README.md`

### Tracker

- keep GitHub transport in `github-client.ts`
- keep GitHub normalization/summarization in focused tracker-side helpers instead of mixing raw API reads with prompt template changes
- do not make the orchestrator parse or sanitize tracker-authored text

### Orchestrator

- continue requesting prompts through `PromptBuilder`
- do not add GitHub-specific conditionals or pass raw tracker payloads into runner sessions

### Runner / Workspace

- no changes expected

## Slice Strategy And PR Seam

One issue / one PR.

This PR should land one reviewable slice:

1. explicit trust-policy contract in repo-owned docs
2. prompt-facing context types plus GitHub prompt-content shaping
3. tests that lock issue-body and review-feedback behavior

Deferred work such as richer issue-comment ingestion, cross-tracker summarization backends, or broader prompt redesign should stay out of this PR so the review surface remains centered on the trust boundary itself.

## Runtime State Model

No new runtime state machine is required for this slice. The issue changes prompt inputs and prompt-contract policy, not retries, continuations, reconciliation, leases, or handoff-state transitions.

## Failure-Class Matrix

Because this slice does not change orchestration recovery behavior, the relevant failures are prompt-contract and normalization failures:

| Observed condition                                                  | Local facts available                                    | Normalized tracker facts available                   | Expected decision                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Issue body contains prompt-injection text or markdown/html wrappers | prompt builder is rendering an issue context             | raw issue title/body metadata                        | render only sanitized summary fields; do not pass raw body                                   |
| Bot review feedback contains prompt-injection text                  | prompt builder is rendering actionable follow-up context | normalized review feedback items                     | render only sanitized summary fields plus URL/location metadata                              |
| Issue has comments but no prompt-comment policy                     | issue metadata, prompt context builder                   | issue comment count or fetched comments if needed    | exclude comments from prompt and document that exclusion explicitly                          |
| Summarization cannot produce usable text from issue/review content  | prompt-context builder error path                        | raw GitHub text still available inside tracker layer | fail loudly with a typed workflow/prompt error rather than silently falling back to raw text |

## Implementation Steps

1. Add prompt-facing domain/config types that model trusted issue metadata, sanitized issue summary, and sanitized review-feedback summaries separately from raw `RuntimeIssue` / `ReviewFeedback`.
2. Add focused GitHub prompt-context shaping helpers that:
   - classify fields by trust level
   - summarize/sanitize issue body text
   - summarize/sanitize actionable review feedback
   - keep issue comments excluded for this slice
3. Update `createPromptBuilder` to render Liquid templates with the prompt-facing context instead of raw tracker entities.
4. Update the checked-in `WORKFLOW.md` prompt body to use the new prompt-facing fields and to state the trust policy explicitly in worker instructions.
5. Update `README.md` and any adjacent docs needed to describe the policy as a repo-owned contract rather than an implementation accident.
6. Add or update contract tests for:
   - workflow prompt rendering with trusted metadata only
   - issue-body sanitization/summarization
   - review-feedback sanitization/summarization
   - explicit issue-comment exclusion
7. Add integration/e2e coverage with GitHub-shaped malicious text to prove the worker receives reduced context rather than raw tracker-authored prompt text.

## Tests

- `tests/unit/workflow.test.ts`
  - assert prompt rendering uses prompt-facing trust-boundary fields rather than raw `issue.description`
  - assert actionable review feedback renders sanitized summaries and URLs/locations, not raw bodies
- new focused unit tests for the GitHub prompt-context/sanitization helper
  - raw markdown/html/input with prompt-injection phrases becomes bounded plain-text summary
  - empty or whitespace-only tracker text degrades to a safe placeholder
- integration coverage under `tests/integration/github-bootstrap.test.ts`
  - normalized actionable feedback remains available for follow-up decisions while prompt-facing summaries are sanitized
- e2e coverage under `tests/e2e/bootstrap-factory.test.ts`
  - malicious issue body still leaves enough context for plan creation / implementation handoff
  - malicious bot review feedback still supports follow-up work without raw body pass-through
- repo contract coverage
  - extend `tests/unit/planning-contract.test.ts` if needed so `WORKFLOW.md` / `README.md` keep the prompt trust policy explicit

## Acceptance Scenarios

1. A GitHub issue with a normal descriptive body produces a worker prompt that includes trusted metadata plus a concise sanitized issue summary.
2. A GitHub issue body containing markdown, HTML, code fences, or prompt-injection language does not appear verbatim in the worker prompt.
3. A PR with actionable automated review feedback gives the worker enough follow-up context through sanitized summaries, author/location metadata, and URLs without exposing raw review bodies.
4. GitHub issue comments remain unavailable to the worker prompt and that exclusion is stated in the repo-owned contract.
5. The trust-boundary code remains GitHub-specific at the integration edge and the prompt builder consumes a tracker-agnostic prompt-facing context shape that future trackers can implement.

## Exit Criteria

- `WORKFLOW.md` explicitly documents which tracker fields are trusted verbatim, summarized/sanitized, or excluded
- prompt rendering no longer receives raw GitHub issue-body or review-feedback text directly
- issue-body and review-feedback handling are covered by automated tests
- the worker prompt still contains enough structured context for implementation and review follow-up
- docs and code describe a seam future non-GitHub trackers can implement without coupling the orchestrator to GitHub rules

## Deferred To Later Issues Or PRs

- repository-owned ingestion/summarization of GitHub issue comments
- cross-tracker prompt trust policies for Linear or future Beads adapters
- optional operator-visible artifacts that preserve fuller tracker text outside the worker prompt
- more advanced summarization strategies if the initial bounded sanitizer proves too lossy

## Decision Notes

- This slice should prefer deterministic sanitization plus structured summaries over opaque LLM summarization so CI tests can prove the boundary.
- Issue comments are explicitly excluded in this PR because adding them would require a separate product decision about which comments are authoritative, how to de-duplicate plan-review/admin chatter, and how to avoid widening the prompt surface again.
- The prompt builder should consume a prompt-facing context contract rather than raw tracker entities so future tracker adapters can implement the same trust-policy vocabulary without leaking GitHub-specific fields upward.
