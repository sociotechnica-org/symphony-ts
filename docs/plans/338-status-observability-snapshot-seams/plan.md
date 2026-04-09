# Issue 338 Plan: Split Factory Status Snapshot Semantics From Rendering And Terminal Transport

## Status

- plan-ready

## Goal

Split the current mixed observability seam so factory status snapshot semantics
have one canonical typed home, human renderers consume that read model without
parsing or defaulting ad hoc, and terminal-facing clients (`status`, `factory
watch`, `factory attach`, and the live TUI loop) stay responsible for transport
concerns instead of snapshot interpretation.

This issue should reduce review churn around `src/observability/status.ts`,
make terminal regressions easier to isolate, and leave the operator-facing
surfaces behaviorally equivalent unless the refactor exposes a small correctness
bug that must be fixed as part of the split.

## Scope

- split the current `src/observability/status.ts` responsibilities into smaller
  modules with explicit ownership for:
  - snapshot contract types plus read/write/parse helpers
  - defaulting and normalization of optional substructures
  - freshness assessment and other derived snapshot semantics
  - human-readable status rendering
- extract terminal-facing render/transport seams so:
  - `factory watch` owns polling, signal handling, and screen clearing only
  - the live TUI loop owns scheduling, fingerprinting, and render timing only
  - terminal write helpers stay separate from pure frame-formatting helpers
- update call sites in CLI and control surfaces to consume the extracted
  semantics/renderer modules instead of reaching into one hot file
- add or update tests so parser/semantic/render/transport contracts are covered
  independently
- update observability docs where they currently describe the status/TUI module
  structure

## Non-goals

- changing tracker transport, normalization, or lifecycle policy
- changing orchestrator retry, continuation, reconciliation, lease, or handoff
  behavior
- redesigning the operator-facing wording, layout, or color model for status,
  watch, or TUI surfaces beyond behavior-preserving extraction
- replacing GNU Screen, the attach broker, or the detached runtime lifecycle
- introducing new `WORKFLOW.md` settings for status rendering or terminal
  transport in this slice
- changing the canonical snapshot schema unless a small compatibility-preserving
  cleanup is required to make semantics explicit

## Current Gaps

- `src/observability/status.ts` currently combines several separable concerns:
  schema/type ownership, JSON parsing, defaulting for optional substructures,
  freshness assessment, and a large human renderer
- `src/cli/factory-control.ts` and `src/cli/index.ts` depend on the same mixed
  status module for parsing, semantics, and wording, which makes even small
  read-side changes broad
- `src/cli/factory-watch.ts` currently mixes transport mechanics with watch
  framing instead of consuming a focused renderer contract
- `src/observability/tui.ts` mixes pure frame formatting with terminal
  capability detection, stdout side effects, and dashboard tick-loop behavior
- recent operator-facing regressions around attach/watch/TUI behavior show that
  terminal transport failures are still too entangled with rendering and read
  model concerns
- current tests prove behavior, but many status and TUI tests still assert
  through large mixed modules instead of smaller contracts

## Decision Notes

- Keep one canonical status snapshot contract. This issue is about splitting
  responsibilities around that contract, not inventing a second status store.
- Prefer extracting pure modules over adding wrapper abstractions. The outcome
  should be smaller obvious files, not another layer of indirection.
- Keep renderers pure where practical. Parsing/defaulting/freshness decisions
  should happen before human-readable text is generated.
- Keep terminal transport deliberately dumb. `factory watch`, the TUI loop, and
  attach-side terminal code should move bytes and manage local terminal state;
  they should not own status semantics.
- Preserve the existing operator contracts unless the refactor exposes a narrow
  bug fix needed to keep those contracts coherent.

## Spec Alignment By Abstraction Level

`SPEC.md` is not vendored in this clone, so this plan uses the mapping in
[`docs/architecture.md`](../../architecture.md).

- Policy Layer
  - belongs: the repo-owned rule that factory status semantics are canonical and
    independent from any one human renderer or terminal client
  - belongs: the rule that watch/attach/TUI clients should consume shared
    read-side contracts rather than embed their own snapshot interpretation
  - does not belong: file layout details, stdout writes, PTY plumbing, or
    screen-clearing escape sequences
- Configuration Layer
  - belongs: none beyond existing fixed observability defaults and module-level
    constants reused by extracted helpers
  - does not belong: new workflow fields or runtime-tunable transport settings
    in this slice
- Coordination Layer
  - belongs: factory-control orchestration continues to inspect detached runtime
    state and pass that typed data into status/watch/attach surfaces
  - does not belong: parsing JSON snapshots, defaulting snapshot substructures,
    or human wording for operator surfaces
- Execution Layer
  - belongs: local terminal/process behavior for `factory watch`, `factory
    attach`, and the live TUI dashboard loop after they consume prepared render
    output
  - does not belong: status freshness policy or snapshot normalization rules
- Integration Layer
  - belongs: host terminal transport details such as TTY checks, PTY wiring,
    Screen attach invocation, resize forwarding, and screen clearing
  - does not belong: snapshot schema ownership, freshness classification, or
    human rendering policy
- Observability Layer
  - belongs: status snapshot contract, normalization/defaulting,
    freshness/read-model derivation, pure human renderers, and TUI frame
    formatting
  - does not belong: tracker-specific policy, attach broker process control, or
    watch-loop signal handling

## Architecture Boundaries

### Status snapshot contract seam

Belongs here:

- `FactoryStatusSnapshot` types and closely related snapshot sub-types
- `deriveStatusFilePath()`
- snapshot read/write helpers
- JSON parsing and validation for the persisted snapshot contract

Does not belong here:

- freshness assessment policy
- human-readable line rendering
- watch/attach/TUI transport behavior

### Status semantics / read-model seam

Belongs here:

- normalization/defaulting helpers for optional status substructures
- freshness classification
- small typed projections or accessors shared by CLI/control/renderers
- behavior that turns parsed snapshot facts into canonical semantic facts

Does not belong here:

- JSON parsing
- string formatting and wording
- stdout or PTY writes

### Human renderer seam

Belongs here:

- `renderFactoryStatusSnapshot()` or its extracted equivalent
- watch-specific framing helpers
- pure frame-formatting helpers used by the TUI
- operator-facing wording that consumes already-normalized semantic inputs

Does not belong here:

- process liveness probes
- file I/O
- signal handling
- terminal raw-mode or child-process launch behavior

### Terminal transport seam

Belongs here:

- `factory watch` poll loop, clear-screen behavior, and interrupt handling
- TUI dashboard tick scheduling, fingerprint dedup, throttled rendering, and
  terminal-write callbacks
- attach-side TTY preflight, resize forwarding, and local detach behavior

Does not belong here:

- snapshot parsing
- freshness/defaulting rules
- ad hoc renderer wording decisions hidden inside transport branches

### Untouched seams

- tracker adapters remain unaware of status renderer and terminal transport
  details
- workspace code does not absorb observability parsing or rendering behavior
- runner implementations keep publishing the same visibility facts through the
  existing runner contract
- orchestrator retry and handoff state machines remain unchanged

## Slice Strategy And PR Seam

This issue should fit in one reviewable PR because the seam is structural and
read-side:

1. extract canonical status snapshot contract and semantics modules from
   `src/observability/status.ts`
2. move human status/watch/TUI formatting behind pure renderer helpers
3. keep watch/TUI/attach clients as transport/process wrappers around those
   renderers
4. update tests and docs to reflect the new module ownership

Deferred from this PR:

- any user-visible redesign of the watch or TUI layout
- broader factory-control redesign beyond consuming the extracted read model
- new runtime persistence contracts
- terminal portability work beyond preserving the existing attach/watch/TUI
  behavior

This seam is reviewable because it stays inside observability/read-model code,
CLI terminal clients, tests, and docs. It does not mix tracker edges,
orchestrator policy, runner transport changes, or detached lifecycle redesign.

## Read-Model And Terminal-Surface State Model

This issue does not change the orchestrator state machine. It makes the
operator-facing status pipeline explicit so failures stay isolated to the layer
that owns them.

### States

1. `snapshot-unavailable`
   - no readable persisted snapshot bytes are available
2. `snapshot-parsed`
   - JSON bytes have been parsed and validated as a typed snapshot contract
3. `semantics-derived`
   - defaulting and freshness/read-model facts have been derived from the typed
     snapshot plus current runtime facts
4. `frame-rendered`
   - a human-readable status/watch/TUI frame has been produced from semantic
     inputs
5. `transport-active`
   - a CLI client or dashboard loop is writing rendered content to stdout or a
     PTY boundary
6. `surface-failed`
   - parse, semantic, render, or transport work failed and the failure has been
     localized to the owning layer

### Allowed transitions

- `snapshot-unavailable -> snapshot-parsed`
- `snapshot-unavailable -> surface-failed`
- `snapshot-parsed -> semantics-derived`
- `snapshot-parsed -> surface-failed`
- `semantics-derived -> frame-rendered`
- `semantics-derived -> surface-failed`
- `frame-rendered -> transport-active`
- `frame-rendered -> surface-failed`
- `transport-active -> frame-rendered`
- `transport-active -> surface-failed`

### Contract rules

- snapshot parsing and validation happen once at the boundary
- renderers consume typed semantic inputs and do not probe process state or
  patch missing substructures inline
- transport clients may retry or redraw, but they should not reinterpret
  snapshot semantics independently
- transport failures should not mutate the underlying snapshot/read-model
  contract

## Failure-Class Matrix

| Observed condition | Local facts available | Canonical semantic facts available | Expected decision |
| --- | --- | --- | --- |
| Status file missing or unreadable | file path, read error, control/runtime liveness facts | none yet | parsing layer reports unavailable/degraded input; renderer and transport consume a typed error path instead of improvising |
| Snapshot exists but worker is offline or no live runtime owns it | typed snapshot plus liveness/runtime-ownership facts | freshness classifier can mark stale/unavailable explicitly | semantic layer classifies freshness once; all renderers surface the same stale/unavailable meaning |
| Optional snapshot substructures are absent | typed partial snapshot fields | normalized defaults for publication, restart recovery, recovery posture, host dispatch, etc. | semantics layer supplies one canonical defaulted view; renderers stop duplicating fallback objects |
| `factory watch` hits a transient inspect/read failure | poll loop, interrupt state, current iteration | typed degraded/unavailable control result | watch transport keeps retrying and reuses the shared renderer/error view instead of embedding bespoke wording logic |
| attach transport fails while runtime is otherwise healthy | TTY facts, helper availability, child exit status | existing snapshot semantics remain unchanged | attach transport reports a local transport failure only; it does not alter snapshot or renderer policy |
| TUI frame formatting regresses without any transport failure | typed `TuiSnapshot`, width, token samples | renderer-only inputs are available | pure renderer tests fail independently of PTY or watch/attach transport harnesses |

## Storage / Persistence Contract

- the existing status snapshot file remains the single persisted status contract
- this issue may move read/write helpers into smaller modules, but it should not
  introduce a second status persistence file
- defaulting and semantic projection remain derived in-process, not separately
  persisted
- transport clients remain stateless with respect to snapshot semantics beyond
  the existing runtime-owned files

## Observability Requirements

- one canonical semantic interpretation of the status snapshot must be reused by
  `status`, `factory status`, `factory watch`, and other operator-facing
  consumers that need those facts
- pure renderers must be testable without live processes or PTY infrastructure
- watch and TUI transport loops must be testable without asserting through
  snapshot parsing or freshness logic
- docs should explain the new module ownership so future observability changes
  do not flow back into one large hot file

## Implementation Steps

1. Extract the persisted factory status contract into a focused module or small
   set of modules under `src/observability/`, moving types plus parse/read/write
   helpers out of the current hot file.
2. Extract normalization/defaulting and freshness/read-model helpers into a
   dedicated semantic module that depends only on typed snapshot inputs plus the
   explicit current-runtime facts it needs.
3. Move the human-readable status renderer into a pure renderer module that
   consumes the extracted semantic helpers instead of defaulting or probing
   liveness inline.
4. Refactor `src/cli/factory-control.ts` and `src/cli/index.ts` to depend on
   the extracted semantic and renderer modules instead of the monolithic status
   file.
5. Extract watch framing into a renderer helper so `src/cli/factory-watch.ts`
   only owns polling, signals, sleep, and terminal clearing.
6. Split `src/observability/tui.ts` so pure frame formatting and event
   humanization stay separate from terminal capability checks, terminal writes,
   and dashboard loop mechanics.
7. Keep `src/cli/factory-attach.ts` transport-only; if the refactor exposes any
   embedded rendering or status-interpretation logic there, move it to the
   shared renderer/semantic seam instead of leaving it local.
8. Update `src/observability/README.md` and any relevant README sections to
   describe the new ownership boundaries and testing strategy.

## Tests And Acceptance Scenarios

### Unit

- snapshot parse/read/write coverage remains green after the contract split
- semantic/defaulting coverage proves missing optional substructures normalize
  once and renderers consume the normalized view
- freshness assessment coverage remains focused on semantic helpers instead of
  renderer entry points
- status renderer coverage proves human output from canonical semantic inputs
  without filesystem/process mocking beyond the liveness facts explicitly passed
- watch renderer/transport coverage proves watch framing is separate from the
  poll loop
- TUI coverage proves pure frame formatting and event humanization without
  needing the dashboard transport loop

### Integration / e2e

- existing detached control/status integration tests still prove the control
  surface renders the same canonical status facts after the split
- existing live TUI smoke coverage still proves `factory watch` and `factory
  attach` behave correctly through real PTY boundaries after transport/render
  extraction

### Acceptance scenarios

1. A developer can update status snapshot semantics in one focused observability
   module without touching terminal clients or renderer wording.
2. A developer can change watch-loop or attach transport behavior without
   modifying snapshot parsing/defaulting code.
3. `pnpm tsx bin/symphony.ts status`, `factory status`, `factory watch`, and
   the live TUI still present consistent status freshness and recovery facts
   after the refactor.
4. A renderer regression can be caught by pure unit tests before PTY smoke
   tests, and a transport regression can be caught without snapshot/parser test
   fallout.

## Exit Criteria

- `src/observability/status.ts` is no longer the mixed ownership point for
  snapshot contract, semantics, and human rendering
- watch and TUI transport code consume pure renderers/read models instead of
  embedding snapshot interpretation
- attach/watch/TUI transport seams are easier to test independently from
  snapshot semantics
- docs and tests reflect the new decomposition
- behavior remains stable on existing status and live-TUI coverage except for
  any narrowly justified bug fix discovered during the split

## Deferred

- further TUI UX or layout redesign
- broader observability view-model unification beyond the factory status/read
  model split
- new operator commands or transport backends
- any tracker or orchestrator behavior changes not required by the structural
  seam in this issue
