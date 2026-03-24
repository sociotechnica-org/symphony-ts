# Why Factory

This document is meant to capture the current thinking about what the Symphony
Factory is for, what it is not for, and how it differs from more ad hoc,
interactive agent environments.

This is intentionally a first-pass concept note, not polished product copy.
For now the goal is to preserve the idea in a durable checked-in place so it
can guide later product and documentation decisions.

## Summary

There appear to be two very different operating worlds for AI systems:

- an ad hoc, interactive, conversational world
- an autonomous, structured, repeatable workflow world

The Factory is for the second world.

That distinction matters because it changes:

- how much structure the system needs
- how much determinism we want
- how much human steering is expected
- whether we are building a system or executing a system

## Two Worlds

### Agent World

Agent World is:

- ad hoc
- interactive
- conversational
- heavily steered by humans
- often best experienced through chat surfaces
- flexible, exploratory, and situational

Examples:

- a Discord-based writing team
- Context Library interactions that are still exploratory and collaborative
- asking an agent for one-off help
- human + agent collaboration where the process is changing in real time

In Agent World, the important things are often:

- conversation
- improvisation
- skillful adaptation
- fast human feedback
- light structure

### Workflow World

Workflow World is:

- structured
- repeatable
- autonomous
- explicitly staged
- optimized over time
- concerned with reliable outputs

Examples:

- taking an issue all the way to a landed PR
- running a recurring maintenance loop on a schedule
- enforcing review/check/landing gates
- executing the same multi-step process reliably over and over

In Workflow World, the important things are often:

- station boundaries
- predictable handoffs
- deterministic progression
- visibility
- recovery
- retries
- policy enforcement

## What The Factory Is For

The Factory is for Workflow World.

More specifically, the Factory exists to enforce and supervise complex,
multi-step, repeatable workflows so they execute reliably and visibly from
start to finish.

Key ideas:

- the Factory is not just “run an agent in the background”
- the Factory is about coordinating a full structured process
- the Factory should optimize and supervise each station in that process
- the Factory is usually concerned with producing durable outputs

Examples of Factory-shaped work:

- software issues that predictably become branches, PRs, reviews, and merges
- scheduled maintenance loops
- repeatable content-processing or artifact-production workflows

## What The Factory Is Not For

The Factory is not automatically the right tool for every useful agent system.

It is probably the wrong tool when the work is still:

- mostly conversational
- highly exploratory
- human-steered at every step
- not yet stable enough to define as a repeatable workflow

This matters because not every multi-agent system should be forced into a
Factory shape just because automation is possible.

## Moving From Agent World To Workflow World

A likely progression looks like:

1. Ask an agent for a thing.
2. Repeat the interaction enough to understand the pattern.
3. Turn that pattern into a skill.
4. Possibly schedule or trigger it automatically.
5. When the process becomes repeatable, multi-step, and worth enforcing,
   wrap a Factory around it.

Important implication:

- not every useful skill needs a Factory
- the Factory is for workflows that are important enough to make structured,
  durable, and autonomous

## Building Systems vs Running Systems

Another key distinction:

- using a Factory to **build** a system
- using a Factory to **run** a system

These are not the same thing.

Examples:

- A Factory may be the right tool to build new skills, agents, evals, or
  software for a company repo.
- But the resulting system may live primarily in Agent World afterward,
  inside a chat environment or a “Claw-like” environment rather than inside
  a Factory.

So we should not confuse:

- “this system was built with a Factory”

with:

- “this system itself should operate as a Factory.”

## Why This Matters For Symphony

This distinction should influence product direction.

For example:

- `WORKFLOW.md` is a good fit for repositories that need a structured,
  repeatable, autonomous process.
- More ad hoc agent teams may need different tooling, even if some of their
  outputs are eventually built or maintained by a Factory.
- Future workflow-topology work should stay grounded in Factory World use cases
  rather than trying to make Symphony solve every agent-interaction problem.

## Near-Term Implication

An important near-term product direction is:

- keep using `symphony-ts` where the work is still clearly Factory-shaped
- allow richer inner sequencing inside one run when it still ends in one
  coherent output (for example one PR)
- avoid prematurely turning every collaborative agent pattern into a workflow
  graph

That suggests a healthy middle ground:

- use Symphony’s current outer factory loop
- enrich the worker prompt with structured inner roles where helpful
- keep true graph/station support as a later architecture step

## Open Naming Question

We still need a better name for the non-Factory world.

The rough shape is:

- a Claw-like environment
- agents + skills + tools + computers
- humans and agents interacting through chat
- influence on the outside world through conversation and tool use

Possible future documentation should probably name this world explicitly so
“Factory” has a real conceptual counterpart.

## Raw Notes

The following notes are preserved almost verbatim from a Discord conversation
so the original framing is not lost during future summarization or compaction.

> just had what I think is a realization
>
> There are two worlds, vastly different, that need different tools
>
> the AD-HOC, INTERACTIVE world of Agents
>
> the AUTONOMOUS, STRUCTURED world of Workflows
>
> The Factory is for Workflow World.
>
> At the moment, the Context Library and Zelda's Writing Team are AD-HOC and INTERACTIVE
>
> they are agents
>
> they need to be in Discord
>
> not in a Factory
>
> BUT
>
> things can cross over from Agent World to Workflow World
>
> when we are trying to predictably, reliably do the same operation over-and-over, it becomes closer to Workflow
>
> we can start by scheduling and interacting with an agent
>
> then move into making that interaction a skill
>
> and that MIGHT be enough
>
> no factory truly needed
>
> (the Factory is about enforcing multi-step, complex workflows execute entirely deterministically, optimizing every station in the workflow)
>
> think about how we have used Pat
>
> starts out just asking for a thing
>
> then make it a skill that can be called at any time
>
> then put it on a cron timer
>
> but when you want to optimize it and execute it autonomously, may be time to wrap a factory around it
>
> Factories also product OUTPUTS
>
> this feels similar to your context library for the context library work...
>
> i need to make a context library for the factory
>
> could be really useful, even as we move to Fabro or something in the future
>
> understand it's role in the system
>
> We may USE a Factory to build the Context Library (it's software, after all!) or build any software steps around the Writing Team (for example, if we wanted evals for grepzilla)
>
> it's different to use a Factory to BUILD a system than it is to use a Factory to RUN/EXECUTE the system
>
> we may have a Factory for building new agents + skills in the company repo
>
> even though they will run in OpenClaw + here in Discord
>
> I don't know what we call the Agent World thing.
>
> it's a Claw-like environment
>
> it's not a factory
>
> it's a place where agents + skills have tools and computers and can interact with humans and each other through chat and influence the outside world
