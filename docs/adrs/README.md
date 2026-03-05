# Architecture Decision Records

This directory holds Architecture Decision Records using Mike Nygard's ADR format.

Use an ADR when a decision is architectural, durable, and likely to matter later.

Examples:

- choosing the core runtime shape
- deciding how Beads state is synchronized with workspaces
- defining the runner event model
- deciding whether workflow reload is static or dynamic
- choosing a remote execution control-plane strategy

Do not use ADRs for routine implementation notes or task checklists. Those belong in issue plans under `docs/plans/`.

## Format

Each ADR should use this structure:

1. Title
2. Status
3. Context
4. Decision
5. Consequences

## Naming

Use zero-padded numeric prefixes:

- `0001-use-architecture-decision-records.md`
- `0002-runtime-service-boundaries.md`
- `0003-beads-state-authority.md`

Keep numbers sequential in merge order.

## Workflow

1. Draft the ADR when the architectural question becomes real.
2. Link the ADR from the relevant issue plan if it affects active work.
3. Update status as the decision evolves.
4. Preserve old ADRs rather than rewriting history silently.

Typical statuses:

- `Proposed`
- `Accepted`
- `Superseded by ADR-XXXX`

## Template

Start from `docs/adrs/template.md`.
