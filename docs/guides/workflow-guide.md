# Workflow Guide

This guide explains how `WORKFLOW.md` is meant to be used in `symphony-ts`.

It is deliberately broader than the quick-start material in the README. The
README should stay focused on getting a factory running. This guide should
be the longer-form reference for:

- how `WORKFLOW.md` fits into the architecture
- what the YAML frontmatter actually controls
- how the prompt body should be written
- common workflow shapes that work well today
- where the current model stops and future workflow-topology work begins

This is a first-pass structure for the guide. The sections below are intended
to give us a stable table of contents and an initial statement of intent for
each section before we fill the whole guide in.

## 1. Purpose

- Define what `WORKFLOW.md` is: the repository-owned runtime contract for one
  Symphony factory instance.
- Explain why it exists as a checked-in file instead of hidden prompt state.
- Clarify that `WORKFLOW.md` is how a repository tells Symphony:
  - where work comes from
  - how to prepare workspaces
  - what runner to use
  - what the worker is expected to do
  - what completion means for that repository

## 2. Boundaries

- Explain what belongs in `WORKFLOW.md`.
- Explain what belongs in `AGENTS.md`.
- Explain what belongs in repo-local skills.
- Explain what must live in code/tests rather than only in prompts.

Suggested framing:

- `WORKFLOW.md` = runtime contract
- `AGENTS.md` = engineering policy
- skills = reusable specialized method
- code/tests = hard correctness guarantees

## 3. File Structure

- Show the basic `WORKFLOW.md` shape:
  - YAML frontmatter
  - markdown prompt body
- Explain how Symphony parses and uses each part.
- Clarify that the body is not “just notes”; it becomes the worker prompt
  template.

## 4. Instance Model

- Explain that one `WORKFLOW.md` defines one local Symphony instance.
- Explain instance-rooted paths:
  - `.tmp/`
  - `.var/`
  - detached runtime checkout
  - workspace roots
- Explain project-local `WORKFLOW.md` vs engine checkout usage.
- Show how `--workflow <path>` selects an instance from a shared engine
  checkout.
- Clarify that the simplest mental model is one running factory per
  `WORKFLOW.md`, but one Symphony engine checkout can operate many workflows
  at once.
- Explain that teams may keep those workflows:
  - in each target repository
  - in a shared workflow-library directory
  - or in another instance-rooted layout, as long as each workflow has its
    own runtime state
- Explain the tradeoff:
  - per-repo `WORKFLOW.md` is the clearest default
  - multiple workflows from one engine checkout are supported and useful, but
    need explicit instance separation

## 5. Frontmatter and Configuration Model

- Explain the role of YAML frontmatter at a narrative level:
  - what it configures
  - what it cannot change
  - which options most directly affect workflow behavior
- Keep this section focused on workflow design and operator understanding,
  not exhaustive field-by-field reference.
- Link to a separate full frontmatter reference file that should eventually be
  the complete parser-aligned source of truth.

Primary link:

- [WORKFLOW Frontmatter Reference](./workflow-frontmatter-reference.md)

This section should point to, and lightly summarize, a separate full reference
document, such as:

### 5.1 Full Frontmatter Reference

- full YAML contract
- defaults where relevant
- parser-aligned option detail
- examples of valid values

This separate reference should eventually cover:

### 5.2 `tracker`

- GitHub and Linear modes
- review bot configuration
- approved review bot configuration
- queue priority configuration

### 5.3 `polling`

- interval
- concurrency
- retry
- watchdog

### 5.4 `workspace`

- root
- repo source
- retention
- worker host settings

### 5.5 `agent`

- runner kind
- command
- prompt transport
- timeout
- max turns
- env

### 5.6 `observability`

- dashboard / refresh settings

## 6. Prompt Body Contract

- Explain what the prompt body should and should not do.
- Explain the trusted context that Symphony injects.
- Explain how normalized lifecycle data appears through the `lifecycle`
  variable and how PR-specific data appears through `pull_request`.
- Explain why prompts should state durable process expectations explicitly.

Key themes to cover:

- the prompt should be repo-owned and explicit
- the prompt should not compensate for missing runtime guarantees when code
  should own them
- the prompt should be specific about completion criteria and QA expectations
- the prompt should assume real issue and PR context will be present

## 7. How Symphony Uses `WORKFLOW.md` at Runtime

- Walk through the lifecycle:
  - load workflow
  - prepare startup/runtime
  - poll tracker
  - create workspace
  - render prompt
  - run worker
  - inspect PR/review/check state
  - continue until handoff
- Clarify where prompt rendering fits into the runtime.
- Clarify what is fixed by the runtime today vs what is prompt-controlled.

## 8. Built-In Symphony Constraints

This section should make the current runtime assumptions explicit so readers
can tell what kinds of work do and do not fit Symphony well today.

It should answer:

- what Symphony assumes even if the prompt body says nothing about it
- what is configurable in frontmatter
- what is currently hard-coded enough that users should design around it

Suggested sub-sections:

### 8.1 Work Source Constraints

- work items come from supported tracker backends only
- today that means GitHub issues or Linear work items
- there is no generic “arbitrary task inbox” backend yet
- one `WORKFLOW.md` selects one tracker backend at a time
- a single workflow does not currently combine GitHub and Linear or pull work
  from multiple tracker sources in one runtime loop

### 8.2 Repository and Delivery Constraints

- Symphony expects a repository-backed workflow
- the current software-factory path assumes one branch and one PR per work
  item
- checks, reviews, and landing are first-class runtime concepts today
- one work item still maps to one outer delivery loop:
  - one issue
  - one workspace
  - one branch
  - one PR
  - one landing outcome
- the current lifecycle model is PR-centric and uses a fixed set of runtime
  handoff states rather than user-defined station names

### 8.3 Runtime Gate Constraints

- required checks must reach acceptable terminal states
- review and landing gates are runtime-owned, not just prompt conventions
- some parts are configurable through frontmatter, but others are currently
  built into the orchestration model
- landing is an explicit runtime operation with built-in blocked reasons
  rather than a free-form prompt decision
- prompt text can influence worker behavior, but it does not replace the
  runtime’s check, review, and landing policy engine

### 8.4 Coordination Model Constraints

- the queue is currently a queue of work items, not a queue of workflow
  stations or subtasks
- one workflow has one runner configuration at a time; the runtime does not
  switch runners per internal stage
- one prepared workspace is still the main execution unit for a work item
- queue priority changes ordering among ready items, but it does not create
  new topology or alternative workflow paths

### 8.5 Fit Assessment

- explain what kinds of workflows are a strong fit
- explain what kinds of workflows are possible only as prompt-level
  approximations
- explain what kinds of workflows do not fit well without deeper runtime
  changes

## 9. Human Handoff Stations

- Explain the current human handoff stations Symphony already enforces:
  - plan approval
  - PR review
  - `/land`
- Explain whether each station is:
  - required by default
  - waivable
  - skippable by configuration
  - only partially configurable today
- Explain how review bots fit into this.
- Explain what kinds of human interaction are first-class today vs only
  prompt-level conventions.
- Explicitly discuss:
  - whether plan approval can be skipped and how
  - whether PR review can be relaxed and how far
  - whether auto-land exists today or would require code changes
  - how these choices interact with Symphony’s current runtime assumptions

## 10. Common Workflow Shapes That Work Well Today

This section should explicitly distinguish:

- what works **today** with the current Symphony runtime
- what requires future graph/station support

Suggested sub-sections:

### 10.1 Standard Software Factory

- single issue
- single workspace
- one branch / one PR
- plan -> implement -> review -> land inside the current runtime

### 10.2 Command-Heavy Maintenance Loop

- repos where the worker mostly runs commands, verifies, and patches

### 10.3 Claude-Specific or Runner-Specific Repositories

- repositories whose prompt/body should assume `claude-code`
- when repo-specific runner guidance belongs in the prompt

### 10.4 Multi-Role Inner Sequence in One Run

- planner -> implementer -> reviewer
- planner -> writer -> editor
- research -> draft -> revise

This is the most important near-term section for current product usage.

## 11. Multi-Role Prompt Patterns

- Describe the intermediate pattern where Symphony still runs one outer
  issue/branch/PR loop, but the worker prompt encodes internal role phases.
- Explain how to phrase that sequence clearly in one `WORKFLOW.md`.
- Explain how repo-local skills can support those roles.
- Explain where subagents can help.

Suggested patterns:

- planner -> implementer -> editor
- planner -> writer -> editor
- spec -> implement -> simplify -> verify

This section should explicitly recommend `planner -> implementer -> editor`
as the default “advanced but current” pattern because it is the closest fit to
Symphony’s current software-delivery runtime and gives the most immediate
benefit.

This section should also explain the limits of this approach:

- good for one PR / one artifact flow
- not true runtime-enforced workflow topology
- not sufficient for branching, durable gates, or complex orchestration

## 12. Tracker-Specific Guidance

### 12.1 GitHub

- issue labels
- PR lifecycle
- check/review/landing semantics
- project priority ordering

### 12.2 Linear

- active/terminal state expectations
- how Linear differs from GitHub’s PR-centric loop

## 13. Runner-Specific Guidance

### 13.1 Codex

- app-server assumptions
- continuation behavior
- token / accounting implications

### 13.2 Claude Code

- command shape
- prompt transport assumptions
- repo cases where Claude-specific behavior belongs in the prompt

### 13.3 Generic Command

- when to use it
- limits compared with first-class runners

## 14. Multi-Instance and Multi-Workflow Usage

- Explain how one engine checkout can operate many repositories.
- Show commands using `--workflow`.
- Clarify that each target project owns its own `WORKFLOW.md`.
- Clarify that detached watch/control is instance-scoped.
- Explain that one engine checkout can also operate many workflows at once,
  even if those workflows are not all checked into the engine repository.
- Show patterns such as:
  - one workflow per target repository
  - one shared workflow-library directory
  - several concurrent local factories from the same engine checkout
- Explain when this is a good idea and when it may become operationally
  confusing.

## 15. Examples

This section should eventually contain excerpts from checked-in example files,
with direct links to the full examples for copy-paste and adaptation.

Examples should live in separate checked-in files so they can be copied
directly, validated over time, and referenced from README and this guide.

This section should eventually contain example excerpts such as:

- minimal self-hosting `symphony-ts`
- GitHub third-party repo
- Claude-only project
- planner -> implementer -> reviewer inner-loop prompt
- planner -> writer -> editor inner-loop prompt

Possible example-file layout:

- `docs/examples/workflows/self-hosting-symphony.md`
- `docs/examples/workflows/github-third-party.md`
- `docs/examples/workflows/claude-only-project.md`
- `docs/examples/workflows/planner-implementer-editor.md`
- `docs/examples/workflows/planner-writer-editor.md`

## 16. Anti-Patterns

- giant vague prompts with no explicit completion bar
- repo policy hidden only in prompt text when it belongs in `AGENTS.md`
- using prompt prose to paper over missing runtime invariants
- pretending prompt-level role sequencing is the same thing as true workflow
  topology
- copying the root `symphony-ts` workflow blindly into unrelated repos

## 17. Migration Path

- ad hoc interactive agent
- repeated manual interaction
- extract a skill
- schedule the skill
- adopt a factory around the repeatable workflow
- later: move to richer station-defined workflows when the runtime supports it

This section should connect directly to the broader “Why Factory” conceptual
material.

## 18. Future Direction

- Acknowledge that Symphony may later support richer workflow/station
  definitions beyond today’s single-prompt contract.
- Link that future direction to the workflow-generalization issue rather than
  pretending `WORKFLOW.md` already supports graph topology.

## Questions To Resolve While Expanding This Guide

- Should we open a follow-up issue to generate the full YAML/frontmatter
  reference from code/tests so it stays parser-aligned automatically?
- What is the right permanent location and naming scheme for checked-in
  workflow example files?
- Which constraints belong directly in this guide versus a separate “current
  runtime limits” concept document?
