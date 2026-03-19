# Issue 189 Plan: Assess Niteshift As A Hosted-Task Remote Runner

## Status

- plan-ready

## Goal

Produce a narrow, checked-in compatibility assessment that evaluates whether Niteshift can fit Symphony's transport-aware remote execution contract as a hosted-task runner without distorting the existing SSH-first architecture. The output should make the current fit, the blocking unknowns, and the smallest credible implementation spike explicit.

## Scope

- capture a written compatibility assessment for Niteshift in the repository
- map the current public Niteshift CLI/task surface onto Symphony's remote execution contract and workflow expectations
- compare Niteshift task lifecycle semantics against the existing SSH remote stdio seam, including:
  - task creation
  - follow-up prompts
  - live watching/streaming
  - local pickup / continuation
  - shutdown / cancellation expectations
  - restart / recovery inspectability
- identify contract mismatches, unknowns, and evidence gaps
- recommend one narrow follow-up issue if the backend appears viable enough to pursue
- update any directly relevant docs index or cross-links only if needed so the assessment is discoverable

## Non-goals

- implementing a Niteshift-backed runner
- changing the runner transport contract, workspace contract, recovery model, or SSH transport to fit Niteshift
- adding workflow/config parsing for a hosted backend in this issue
- depending on the live Niteshift service in CI or automated tests
- validating private or undocumented APIs as though they were stable contract
- broadening this issue into a generic hosted-task backend abstraction

## Current Gaps

- The current execution contract already models `remote-task`, but no real hosted-task backend has been assessed against that shape.
- Existing remote execution work is SSH-first:
  - `#182` separates provider identity from transport identity and allows `remote-task`.
  - `#183` generalizes workspaces for local and remote targets.
  - `#184` makes recovery and shutdown transport-aware.
  - `#187` lands the first real remote transport as SSH stdio for Codex app-server.
- Public Niteshift signals indicate a hosted task model rather than an SSH-like stdio transport:
  - the npm package `niteshift@0.6.5` describes itself as the official CLI for `niteshift.dev`
  - the published README exposes `run`, `watch`, `prompt`, `pickup`, `handoff`, `terminal`, and `sync` commands
  - local validation on 2026-03-19 confirmed the published CLI help for:
    - `niteshift --help`
    - `niteshift run --help`
    - `niteshift watch --help`
    - `niteshift prompt --help`
    - `niteshift pickup --help`
    - `niteshift handoff --help`
    - `niteshift terminal --help`
  - the public changelog advertises follow-up prompting, task watching, local pickup, persistent terminal sessions, and PR/CI workflows
- Critical hosted-backend details remain unclear from the public contract surface:
  - non-interactive cancellation / shutdown semantics
  - whether watch output is a stable event schema or only user-facing stream text
  - restart recovery hooks for reconnecting to existing tasks without local agent state
  - task ownership semantics when Symphony, not a human, is the orchestrator

## Evidence Sources

- checked-in Symphony contracts and plans:
  - `docs/architecture.md`
  - `docs/plans/182-runner-transport-and-remote-execution-contract/plan.md`
  - `docs/plans/183-generalize-workspace-contract-for-local-and-remote-targets/plan.md`
  - `docs/plans/184-generalize-active-run-identity-shutdown-and-recovery/plan.md`
  - `docs/plans/187-ssh-stdio-transport-for-remote-codex-app-server-sessions/plan.md`
- current local implementation around:
  - `src/runner/service.ts`
  - `src/domain/workspace.ts`
  - `src/domain/workflow.ts`
  - status / ownership readers for `remote-task`
- public Niteshift evidence gathered during this issue:
  - npm package metadata and published README for `niteshift`
  - published CLI help from `npx -y niteshift@0.6.5 ... --help`
  - the public Niteshift changelog on `niteshift.dev/changelog`
- anything beyond those public surfaces should be treated as unknown unless a later implementation spike validates it directly

## Decision Notes

- Keep the SSH/spec-aligned path as the architectural baseline. The assessment should ask whether Niteshift can fit that contract, not whether Symphony should reshape itself around a hosted service.
- Treat Niteshift as a likely `remote-task` transport, not a `remote-stdio-session`, unless concrete evidence shows equivalent long-lived stdio semantics.
- Preserve Symphony as the orchestrator and source of truth for issue state, retries, recovery, and PR lifecycle if a Niteshift slice is pursued.
- Prefer an assessment document in the repo over an issue comment alone so the reasoning remains inspectable and reusable by later issues.
- If the public contract is too incomplete to support a safe first slice, the assessment should say so plainly and recommend stopping rather than speculating.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the abstraction mapping in `docs/architecture.md`.

- Policy Layer
  - belongs: deciding whether a hosted-task backend fits Symphony's architecture, what constraints must remain true, and what first slice would be acceptable
  - does not belong: runtime implementation work, ad hoc service-specific workarounds, or changing SSH-first policy to match Niteshift quirks
- Configuration Layer
  - belongs: documenting likely future config needs as assessment output only
  - does not belong: parser/schema changes in this issue
- Coordination Layer
  - belongs: analyzing how continuation, retries, restart recovery, and shutdown would map conceptually onto a hosted task backend
  - does not belong: orchestrator code changes or recovery-policy rewrites
- Execution Layer
  - belongs: assessing whether Niteshift matches `remote-task` semantics, what workspace/session/task identity would be required, and where the contract does or does not fit
  - does not belong: transport implementation or provider/client code
- Integration Layer
  - belongs: untouched in this slice
  - does not belong: tracker changes or hosted-service adapter work
- Observability Layer
  - belongs: identifying the task/session/url/log facts Symphony would need from a hosted-task transport
  - does not belong: status/artifact schema implementation in this issue

## Architecture Boundaries

### Belongs in this issue

- one checked-in assessment document, likely under `docs/`
- a compatibility matrix between Symphony's remote execution contract and Niteshift's visible task surface
- a concrete list of unknowns / blockers
- a recommendation for one narrow follow-up implementation issue if viable
- minimal doc cross-linking if needed to keep the assessment discoverable

### Does not belong in this issue

- runner/workspace/orchestrator code changes
- contract redesign
- private reverse engineering framed as stable product support
- CI/networked integration tests against Niteshift
- broad "hosted backend" abstraction work

## Layering Notes

- `config/workflow`
  - remains unchanged in code
  - assessment may describe likely future config such as hosted runner credentials, repository binding, and task-routing options
  - does not gain speculative schema in this issue
- `tracker`
  - remains unchanged
  - assessment may note how Symphony must stay the source of truth instead of delegating tracker policy to Niteshift
- `workspace`
  - assessment should note that a hosted-task backend may not expose the same remote workspace preparation seam as SSH
  - does not add workspace-target variants or hosted checkout policy in this issue
- `runner`
  - assessment should compare the existing `remote-task` contract with Niteshift task creation, prompt, watch, pickup, and cancellation semantics
  - does not add a Niteshift runner
- `orchestrator`
  - assessment should identify what durable task identity and recovery hooks the orchestrator would require
  - does not change retries, continuation sequencing, or shutdown behavior
- `observability`
  - assessment should identify the minimum hosted-task facts needed in status/artifacts, such as task id, task URL, branch, PR link, watch/log pointers, and termination state
  - does not change status rendering or artifact persistence in this issue

## Slice Strategy And PR Seam

This issue should land as one small, reviewable documentation PR:

1. add a checked-in Niteshift compatibility assessment
2. anchor it against the existing transport-aware SSH-first contract
3. recommend either:
   - one narrow first Niteshift-backed implementation slice, or
   - an explicit stop because the contract mismatch or evidence gap is too large

This remains reviewable because it does not combine:

- assessment with implementation
- hosted-backend speculation with contract redesign
- docs work with tracker or orchestrator code churn

## Hosted-Task Lifecycle Mapping

This issue does not change runtime behavior, but the assessment needs an explicit conceptual state model so the compatibility decision is testable instead of hand-wavy.

### Symphony states to evaluate

1. `workspace-prepared`
2. `session-starting`
3. `turn-running`
4. `waiting`
5. `turn-complete`
6. `shutdown-requested`
7. `failed`
8. `closed`

### Niteshift lifecycle surfaces to map

1. task creation via `niteshift run`
2. follow-up dispatch via `niteshift prompt`
3. live output / event stream via `niteshift watch`
4. local continuation via `niteshift pickup`
5. interactive terminal attachment via `niteshift terminal`
6. repository/task synchronization via `niteshift sync`

### Mapping questions the assessment must answer

- What is the stable task identity Symphony can persist and later recover?
- Does follow-up prompting target an existing remote task/session reliably enough for continuation turns?
- Can Symphony observe enough structured progress/completion state without scraping user-oriented text?
- Can Symphony request shutdown/cancellation non-interactively, or would it only be able to abandon a task?
- Does local `pickup` preserve enough session identity to let Symphony reason about ownership and recovery?
- Which task facts are authoritative in Niteshift versus still owned by Symphony?

## Failure-Class Matrix

| Observed condition                                              | Local facts available                            | Public Niteshift facts available                                     | Assessment question / expected conclusion                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Symphony wants to start a remote run                            | issue, branch, prompt, remote workspace contract | `run` command, branch/base flags, watch option                       | decide whether task creation can represent one Symphony run without hiding required workspace/branch facts |
| Symphony wants a continuation turn on an existing run           | persisted task/session identity                  | `prompt <taskId>` command                                            | decide whether `taskId` is a sufficient durable continuation handle                                        |
| Symphony wants live operator visibility                         | stored run identity                              | `watch <taskId>` with optional `--json`                              | decide whether watch output is stable enough for observability or only human-facing                        |
| Factory restarts with an active hosted run                      | persisted issue/run state, maybe task id         | `pickup [taskId]`, `list`, `sync`                                    | decide whether restart recovery can reconnect deterministically without manual intervention                |
| Symphony wants to stop an in-flight run                         | shutdown/retry policy, persisted task identity   | no clearly documented cancel/stop command in public README/changelog | likely blocker or open question unless a non-interactive cancellation path is found                        |
| Hosted backend already opened a PR or changed branch state      | tracker facts, local repo facts                  | changelog mentions PR links and merge-ready workflows                | decide whether Symphony can remain the source of truth instead of ceding PR lifecycle control              |
| Hosted task is still healthy but local CLI/runtime is gone      | task id, tracker state                           | watch/pickup/sync surfaces                                           | decide whether the backend supports inspectable reattachment versus opaque eventual consistency            |
| Public CLI/package surface is unstable or environment-sensitive | local Node/runtime evidence                      | npm package metadata, local `npx` failure                            | capture toolchain/operability risk separately from architectural fit                                       |

## Storage / Persistence Contract

- no new runtime persistence is introduced in this slice
- the assessment should name the durable facts a future hosted-task runner would need at minimum:
  - hosted task id
  - hosted task URL
  - provider / model identity
  - branch and PR references
  - hosted session or continuation handle, if distinct from task id
  - watch/log pointers or recovery lookup keys
  - cancellation capability state, if any
- if Niteshift cannot supply a stable subset of those facts, the assessment should treat that as a first-class mismatch

## Observability Requirements

The assessment should explicitly state what Symphony would need to surface for a hosted-task backend:

- task id and task URL
- branch/base branch and PR link if the backend owns those facts
- whether the backend is in running, waiting, completed, failed, or abandoned state
- whether output can be tailed or replayed deterministically
- whether shutdown/cancellation support is present, absent, or unknown
- whether local pickup created a new local agent boundary or preserved one remote-session identity

## Implementation Steps

1. Create a checked-in assessment document, likely `docs/assessments/niteshift-hosted-task-runner.md`.
2. Summarize the relevant Symphony contract baseline from `#182`, `#183`, `#184`, and `#187` in that document.
3. Collect and cite the current public Niteshift evidence used for the assessment:
   - npm metadata / published README
   - public changelog entries relevant to task lifecycle semantics
4. Build a compatibility matrix covering:
   - task creation
   - follow-up prompts
   - watching / streaming
   - pickup / continuation
   - shutdown / cancellation
   - restart / recovery
   - status / observability
5. Classify each area as:
   - compatible
   - compatible with caveats
   - blocked by unknowns
   - mismatched with current contract
6. Conclude with one of two outcomes:
   - recommend a smallest viable first implementation slice, or
   - recommend deferring Niteshift until missing contract evidence exists
7. Add only minimal README/docs cross-links if the assessment would otherwise be difficult to discover.

## Tests And Acceptance Scenarios

### Validation approach

- manual review of the assessment against current checked-in contracts and public Niteshift evidence
- verify all referenced local doc paths are valid
- if doc cross-links are added, verify they resolve and describe the correct issue/doc path

### Acceptance scenarios

1. A reader can tell whether Niteshift fits the current `remote-task` seam, needs a second hosted-backend shape, or should not be pursued yet.
2. The assessment names the blocking unknowns explicitly, especially around cancellation, structured event streaming, and restart recovery.
3. The assessment makes clear that SSH remains the primary reference path and that Symphony stays the orchestrator/source of truth.
4. If Niteshift looks viable, the next implementation slice is narrow and reviewable.
5. If Niteshift does not look viable yet, the reason is explicit and evidence-based rather than speculative.

## Exit Criteria

- a checked-in Niteshift compatibility assessment exists
- the assessment cites the Symphony contract seam it is evaluating
- the assessment clearly distinguishes compatible areas, mismatches, and unknowns
- the next action is explicit: pursue one narrow spike or defer pending better contract evidence

## Deferred To Later Issues Or PRs

- a real Niteshift runner implementation
- config/schema changes for hosted-task backends
- test doubles or CI harnesses for hosted remote task backends
- broader hosted-backend abstraction work across multiple services
- any change to SSH remote stdio design motivated only by Niteshift
