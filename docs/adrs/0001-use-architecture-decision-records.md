# ADR-0001: Use Architecture Decision Records

## Status

Accepted

## Context

`symphony-ts` is being built in phases, starting from a bootstrap implementation and moving toward a durable orchestration runtime with Beads as the primary tracker backend.

Several architectural questions will shape the implementation materially:

- runtime service boundaries
- workflow contract scope
- Beads state authority and sync behavior
- runner event model
- remote execution strategy

These decisions should be preserved in a form that is easy to find, easy to review, and stable over time. They should not live only in issue comments or ephemeral chat.

## Decision

Architectural decisions will be recorded in `docs/adrs/` using Mike Nygard's ADR format:

1. Title
2. Status
3. Context
4. Decision
5. Consequences

Issue-level task planning remains in `docs/plans/`.

## Consequences

- The repository now has a durable place for architectural decisions.
- Implementation plans can reference ADRs when a task depends on a larger design choice.
- Architectural history will be easier to audit as the runtime evolves.
- Contributors must decide when a question is important enough to justify an ADR instead of burying the decision in a task plan.
