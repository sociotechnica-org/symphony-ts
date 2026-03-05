# symphony-ts

TypeScript implementation of the Symphony spec.

Current objective: complete Phase 0 so Symphony can build Symphony.

## Local Bootstrap Usage

Prerequisites:

1. `gh auth login`
2. `codex` installed locally
3. GitHub issue labels `symphony:ready`, `symphony:running`, and `symphony:failed`

Install dependencies:

```bash
pnpm install
```

Run one poll cycle:

```bash
pnpm tsx bin/symphony.ts run --once
```

Run continuously:

```bash
pnpm tsx bin/symphony.ts run
```

Issues labeled `symphony:ready` in `sociotechnica-org/symphony-ts` are eligible for dispatch.
