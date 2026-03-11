# Plan: Rewrite README for External Audiences

## Goal

Rewrite `README.md` so that someone encountering symphony-ts for the first time can understand what it is, why it exists, how to run it, and how to extend it — in that order. The current README is accurate but written for an insider who already knows the project. The new README should sell the vision, then teach.

## Competitive README Analysis

Six comparable OSS projects were evaluated. Key takeaways:

### Ranking (best to worst)

1. **agent-orchestrator** (ComposioHQ) — Best overall README
   - **Pros:** Opens with a one-line value prop + concrete tagline. "Why" section that names the pain. Clean CLI reference. Plugin table shows extensibility at a glance. YAML config example is immediately copy-pasteable. Progressive disclosure: quick start → how it works → config → CLI → why → dev.
   - **Cons:** Slightly long. The "Why" section could be higher.
   - **Lesson:** Lead with the pitch, show the plugin surface, make config concrete.

2. **agentsview** (wesm) — Excellent install-to-value README
   - **Pros:** One-liner that says exactly what it does. Curl-install one-liner. Keyboard shortcuts table signals polish. Feature list is tight and scannable. Project structure section helps contributors orient fast.
   - **Cons:** No "why" / motivation section. No architecture diagram. Narrow scope (viewer, not orchestrator) so less comparable.
   - **Lesson:** Ruthless brevity works. Keyboard shortcut tables and feature lists signal maturity.

3. **codex-autorunner (CAR)** — Strong philosophy, weaker onboarding
   - **Pros:** "Tickets as code" concept is memorable and well-explained. Philosophy section ("bitter-lesson-pilled") gives personality. Multiple interaction patterns (Web, CLI, Chat, PMA) are clearly laid out.
   - **Cons:** Quickstart is vague ("pass the setup guide to any AI agent"). No concrete install commands. Architecture section defers to external docs without a summary.
   - **Lesson:** A strong conceptual hook matters, but you still need concrete install steps.

4. **connect-the-bots (Attractor)** — Technically impressive, hard to grok
   - **Pros:** Verification architecture section is thorough. Feature list is comprehensive. Dual-license clearly stated. Cargo install is simple.
   - **Cons:** Opens with "DOT-based pipeline runner" — too implementation-focused for a first line. The six verification layers are detailed but overwhelming upfront. No "why" section. Hard to understand what you'd use it for without reading deeply.
   - **Lesson:** Technical depth is great, but bury it below the pitch and quickstart.

5. **background-agents** (ColeMurray) — Good architecture docs, poor entry point
   - **Pros:** Security architecture section is honest and thorough. Package table is clean. Links to separate detailed docs (SETUP_GUIDE, HOW_IT_WORKS, AUTOMATIONS).
   - **Cons:** Opens with a feature bullet list instead of a value prop. Security warnings dominate the top of the README. No quickstart in the README itself — defers to separate files. Hard to tell if this is for you without clicking through.
   - **Lesson:** Don't lead with caveats. Separate docs are fine but the README needs a self-contained quickstart.

6. **otter-camp** (samhotchkiss) — Functional but flat
   - **Pros:** Docker quickstart is concrete and copy-pasteable. Environment variable table is comprehensive.
   - **Cons:** No explanation of what it actually does beyond "self-hosted AI team coordination platform." No architecture overview, no "why," no feature list. Jumps straight into `docker compose` without motivation. Reads like internal ops docs.
   - **Lesson:** Even a great quickstart fails if people don't know why they should care.

### Patterns That Work Across the Best READMEs

| Pattern                                       | Where it works                             |
| --------------------------------------------- | ------------------------------------------ |
| One-line value prop at the very top           | agent-orchestrator, agentsview             |
| "Why" / problem statement section             | agent-orchestrator, CAR                    |
| Copy-pasteable quickstart with < 5 commands   | agent-orchestrator, agentsview, otter-camp |
| Plugin/adapter table showing extensibility    | agent-orchestrator                         |
| Concrete config example                       | agent-orchestrator                         |
| Project structure / repo map for contributors | agentsview, Attractor                      |
| Separate detailed docs linked from README     | background-agents, Attractor               |

### Anti-Patterns to Avoid

- Opening with implementation details instead of value prop (Attractor)
- Leading with security warnings or caveats (background-agents)
- Deferring quickstart to separate files (background-agents)
- No "why" section at all (otter-camp, agentsview)
- Vague quickstart that doesn't show actual commands (CAR)

## Proposed README Structure

```
# symphony-ts

{one-line tagline: what it is + what it does}

{2-3 sentence expansion: the vision, the pain it solves}

## Why Symphony?

{The problem: babysitting tickets across multiple agents is unmanageable.
 The insight: OpenAI's Symphony spec nailed the right abstraction layers.
 The solution: a local-first, pluggable orchestrator that makes the factory visible.}

{Bullet list of what makes it different:}
- Runs locally — no hosted infrastructure
- Adapter pattern — pluggable trackers and workers
- State lives in the tracker — no centralized state, multiple instances stay in sync
- Visibility — see what every worker is doing
- Self-hosting — Symphony builds itself

## Quick Start

{4-5 concrete, copy-pasteable commands from clone to first run}

## How It Works

{Concise lifecycle description: issue → claim → branch → plan review → implement → PR → follow-up → done}
{Keep this to ~10-15 lines max, link to architecture.md for depth}

## Configuration

{Show WORKFLOW.md structure briefly}
{Key fields table}
{Link to full WORKFLOW.md reference}

## Architecture

{Plugin/adapter table showing what's swappable:}
| Layer | Current Default | Alternatives |
|-------|----------------|--------------|
| Tracker | GitHub Issues | (Linear planned) |
| Runner | Local Codex CLI | (Remote workers planned) |
| Workspace | Local git clone | — |

{Repo map (keep existing one, it's good)}

## Development

{Install, lint, typecheck, test — the local gate}

## Current Status & Roadmap

{What phase we're in, what works today, what's next}
{Link to relevant issues/milestones}

## Documentation

{Links to architecture.md, golden-principles.md, AGENTS.md, plans/, adrs/}

## License
```

### Justification for Each Section

| Section                 | Why it exists                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tagline + expansion** | The #1 failure mode is people bouncing because they can't figure out what the project does in 10 seconds. Every good README opens with this.                                                                                         |
| **Why Symphony?**       | This is where the passion and vision live. Your "visible factory" framing is compelling and differentiating. Without this, symphony-ts looks like "yet another agent orchestrator." This section is what makes people star the repo. |
| **Quick Start**         | If someone is intrigued by the pitch, the next question is "can I try it?" Every top-ranked README has this within the first scroll. Must be self-contained, concrete, and < 5 commands.                                             |
| **How It Works**        | After trying it, people want a mental model. The current README's lifecycle description is good but buried. Pull it up, tighten it, add a simple flow diagram if possible.                                                           |
| **Configuration**       | Shows the project is configurable without being complex. The WORKFLOW.md concept is a differentiator — "your entire factory config is one markdown file."                                                                            |
| **Architecture**        | The adapter/plugin table is the single most effective element from agent-orchestrator's README. It signals extensibility and invites contribution. The repo map helps contributors orient.                                           |
| **Development**         | Standard for any OSS project. People need to know how to run the local gate before contributing.                                                                                                                                     |
| **Status & Roadmap**    | Honest about what works and what doesn't. Prevents wasted time from people expecting features that don't exist yet. Also signals active development.                                                                                 |
| **Documentation**       | Consolidates links. Prevents the README from trying to be all docs at once.                                                                                                                                                          |
| **License**             | Standard. Currently missing from the README.                                                                                                                                                                                         |

## Sections to Remove or Relocate

From the current README:

- **"How to Use Symphony to Build Symphony"** — Move to a separate doc (e.g., `docs/self-hosting.md` or `docs/guides/building-symphony-with-symphony.md`). It's fascinating for contributors but too long for a README. Link to it from the README instead.
- **"References"** — Keep but move to bottom, trim to essential links only.
- **"Prerequisites"** — Fold into Quick Start.
- **"Current Constraints"** — Fold into "Status & Roadmap."
- **Duplicate Quick Start sections** — The current README has quickstart info in three places. Consolidate.

## Tone Guidance

The current README is accurate and thorough but reads like internal documentation. The new README should:

- Lead with energy and conviction (borrow from your "visible factory" framing)
- Use "you" language ("Point it at your repo and it starts working issues")
- Be concrete over abstract ("runs Codex against your codebase" not "executes agent subprocesses")
- Show, don't tell (config examples, CLI output, lifecycle diagrams)
- Stay honest about constraints (single-instance, local-only for now)

## Content to Pull From Your "Visible Factory" Notes

These phrases from your notes should be adapted into the README:

- "a way to actually see what's happening" → drives the "Visibility" bullet
- "no single pane of glass" → drives the "Why" problem statement
- "software-based orchestrator that sits on top of a bunch of workers" → drives the tagline
- "runs locally, no hosted infrastructure, no complexity" → drives the "Runs locally" bullet
- "the entire factory state lives in Linear itself" → drives the "State lives in the tracker" bullet
- "it builds itself" → becomes a memorable proof point
- "configure the workflow stages with a single workflow.md document" → drives the Configuration section

## Implementation Steps

1. Draft the new README following the proposed structure above
2. Extract "How to Use Symphony to Build Symphony" into `docs/guides/self-hosting-loop.md`
3. Update cross-references (any docs that link to specific README sections)
4. Add a LICENSE file if one doesn't exist (check current state)
5. Review the result against the top-ranked competitor READMEs for parity

## Non-Goals

- Rewriting architecture.md or other docs (separate effort)
- Adding badges, CI status indicators, or contributor graphics (premature for current phase)
- Creating a project website or landing page
- Changing any code or configuration
