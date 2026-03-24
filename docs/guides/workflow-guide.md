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

## 5. YAML Frontmatter Reference

- Document each frontmatter section:
  - `tracker`
  - `polling`
  - `workspace`
  - `hooks`
  - `agent`
  - `observability`
- Include field-by-field explanation and defaults where relevant.
- Keep this aligned with the actual parser contract in code.

This section should eventually split into:

### 5.1 `tracker`

- GitHub and Linear modes
- review bot configuration
- approved review bot configuration
- queue priority configuration

### 5.2 `polling`

- interval
- concurrency
- retry
- watchdog

### 5.3 `workspace`

- root
- repo source
- retention
- worker host settings

### 5.4 `agent`

- runner kind
- command
- prompt transport
- timeout
- max turns
- env

### 5.5 `observability`

- dashboard / refresh settings

## 6. Prompt Body Contract

- Explain what the prompt body should and should not do.
- Explain the trusted context that Symphony injects.
- Explain how issue/PR lifecycle data appears in the template.
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

## 8. Common Workflow Shapes That Work Well Today

This section should explicitly distinguish:

- what works **today** with the current Symphony runtime
- what requires future graph/station support

Suggested sub-sections:

### 8.1 Standard Software Factory

- single issue
- single workspace
- one branch / one PR
- plan -> implement -> review -> land inside the current runtime

### 8.2 Command-Heavy Maintenance Loop

- repos where the worker mostly runs commands, verifies, and patches

### 8.3 Claude-Specific or Runner-Specific Repositories

- repositories whose prompt/body should assume `claude-code`
- when repo-specific runner guidance belongs in the prompt

### 8.4 Multi-Role Inner Sequence in One Run

- planner -> implementer -> reviewer
- planner -> writer -> editor
- research -> draft -> revise

This is the most important near-term section for current product usage.

## 9. Multi-Role Prompt Patterns

- Describe the intermediate pattern where Symphony still runs one outer
  issue/branch/PR loop, but the worker prompt encodes internal role phases.
- Explain how to phrase that sequence clearly in one `WORKFLOW.md`.
- Explain how repo-local skills can support those roles.
- Explain where subagents can help.

Suggested patterns:

- planner -> implementer -> editor
- planner -> writer -> editor
- spec -> implement -> simplify -> verify

This section should also explain the limits of this approach:

- good for one PR / one artifact flow
- not true runtime-enforced workflow topology
- not sufficient for branching, durable gates, or complex orchestration

## 10. Human Review, Landing, and Gates

- Explain the current human handoff stations Symphony already enforces:
  - plan approval
  - PR review
  - `/land`
- Explain how review bots fit into this.
- Explain what kinds of human interaction are first-class today vs only
  prompt-level conventions.

## 11. Tracker-Specific Guidance

### 11.1 GitHub

- issue labels
- PR lifecycle
- check/review/landing semantics
- project priority ordering

### 11.2 Linear

- active/terminal state expectations
- how Linear differs from GitHub’s PR-centric loop

## 12. Runner-Specific Guidance

### 12.1 Codex

- app-server assumptions
- continuation behavior
- token / accounting implications

### 12.2 Claude Code

- command shape
- prompt transport assumptions
- repo cases where Claude-specific behavior belongs in the prompt

### 12.3 Generic Command

- when to use it
- limits compared with first-class runners

## 13. Multi-Instance Usage

- Explain how one engine checkout can operate many repositories.
- Show commands using `--workflow`.
- Clarify that each target project owns its own `WORKFLOW.md`.
- Clarify that detached watch/control is instance-scoped.

## 14. Examples

This section should eventually contain complete examples, such as:

- minimal self-hosting `symphony-ts`
- GitHub third-party repo
- Claude-only project
- planner -> implementer -> reviewer inner-loop prompt
- planner -> writer -> editor inner-loop prompt

## 15. Anti-Patterns

- giant vague prompts with no explicit completion bar
- repo policy hidden only in prompt text when it belongs in `AGENTS.md`
- using prompt prose to paper over missing runtime invariants
- pretending prompt-level role sequencing is the same thing as true workflow
  topology
- copying the root `symphony-ts` workflow blindly into unrelated repos

## 16. Migration Path

- ad hoc interactive agent
- repeated manual interaction
- extract a skill
- schedule the skill
- adopt a factory around the repeatable workflow
- later: move to richer station-defined workflows when the runtime supports it

This section should connect directly to the broader “Why Factory” conceptual
material.

## 17. Future Direction

- Acknowledge that Symphony may later support richer workflow/station
  definitions beyond today’s single-prompt contract.
- Link that future direction to the workflow-generalization issue rather than
  pretending `WORKFLOW.md` already supports graph topology.

## Questions To Resolve While Expanding This Guide

- How much frontmatter reference should live here vs README?
- Should the YAML reference become generated from code/tests later?
- Should the multi-role examples live inline here or in separate example files?
- Should we explicitly recommend planner -> implementer -> editor as the
  default “advanced but current” pattern?
