# Niteshift Hosted-Task Runner Assessment

Issue: `#189`  
Date: `2026-03-19`

## Verdict

Niteshift appears architecturally closer to Symphony's `remote-task` transport
than to the SSH-first `remote-stdio-session` seam. The public surface is
promising enough to justify a narrow follow-up validation spike, but it is not
yet sufficient for a safe production runner integration.

Current conclusion:

- task creation, follow-up prompting, and live watch semantics look compatible
  with a hosted `remote-task` runner
- local pickup and terminal attachment suggest that durable remote task identity
  exists, but the public contract does not make restart recovery guarantees
  explicit enough for Symphony's recovery model
- non-interactive shutdown or cancellation is not documented on the public CLI
  surface and is the most important blocker
- Niteshift should not influence Symphony's SSH-first baseline or push the core
  contract toward hosted-service-specific behavior

Recommended stance:

- treat Niteshift as a possible future `remote-task` backend
- do not start a mainline runtime integration until cancellation, structured
  watch output expectations, and recovery lookup guarantees are validated

## Symphony Baseline

The current Symphony baseline comes from the checked-in remote-execution plans:

- [Issue 182](../plans/182-runner-transport-and-remote-execution-contract/plan.md)
  separates provider identity from transport identity and explicitly allows
  `remote-task`.
- [Issue 183](../plans/183-generalize-workspace-contract-for-local-and-remote-targets/plan.md)
  generalizes the workspace layer for local and remote targets.
- [Issue 184](../plans/184-generalize-active-run-identity-shutdown-and-recovery/plan.md)
  makes shutdown and recovery transport-aware.
- [Issue 187](../plans/187-ssh-stdio-transport-for-remote-codex-app-server-sessions/plan.md)
  keeps SSH stdio as the first concrete remote path.

That baseline matters because Niteshift should fit the existing
`remote-task` seam. It should not redefine:

- workspace ownership
- retry/recovery policy
- tracker ownership
- PR lifecycle ownership

Symphony must remain the orchestrator and system of record.

## Evidence Scope

This assessment uses only public evidence that was current on March 19, 2026:

- the published npm package metadata for `niteshift@0.6.5`
- the published package README shipped inside `niteshift-0.6.5.tgz`
- the public product site at <https://niteshift.dev/>
- the public changelog at <https://niteshift.dev/changelog>

Local CLI execution through `npx niteshift@latest` was not reliable in this
workspace because npm hit local symlink conflicts during install. To avoid
treating environment-specific install noise as product behavior, this
assessment used the published package tarball instead of a live login flow.

## Public Niteshift Surface

As of March 19, 2026, the published package identifies itself as:

- package: `niteshift@0.6.5`
- description: "Official CLI for niteshift.dev"

The shipped README exposes these commands:

- `niteshift run <prompt>`
- `niteshift watch <taskId>`
- `niteshift prompt <taskId> [prompt]`
- `niteshift list`
- `niteshift pickup [taskId]`
- `niteshift handoff [sessionId]`
- `niteshift terminal new`
- `niteshift terminal attach [taskId]`
- `niteshift sync`

The public site and changelog reinforce the hosted-task model:

- the homepage says Niteshift runs the full dev environment in the cloud
- the January 12, 2026 changelog adds a built-in terminal with persistent tmux
  sessions
- the January 19, 2026 changelog adds local pickup that preserves session
  context
- the February 23, 2026 changelog adds `watch` and `prompt`
- the January 5, 2026 changelog describes PR and CI automation

Inference from those sources:

- Niteshift is a hosted task system with its own remote workspace and lifecycle
- the most natural Symphony mapping is `transport=remote-task`
- the public evidence does not support treating it as an SSH-like long-lived
  stdio session

## Compatibility Matrix

| Contract area               | Public Niteshift evidence                                                                                        | Fit                                               | Assessment                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task creation               | `niteshift run <prompt>` with branch/base flags and optional `--watch`                                           | Compatible with caveats                           | Good match for "start one hosted run" semantics. The caveat is that the hosted backend, not Symphony, appears to own remote environment setup.         |
| Follow-up prompts           | `niteshift prompt <taskId> [prompt]` with optional `--watch` and `--json`                                        | Compatible                                        | This maps cleanly to continuation turns if `taskId` is a durable handle.                                                                               |
| Live watch / streaming      | `niteshift watch <taskId>` with `--json`, `--all`, `--last`, `--no-follow`                                       | Compatible with caveats                           | A strong signal for observability. The caveat is that the public contract does not document the JSON message schema as stable.                         |
| Local pickup / continuation | `niteshift pickup [taskId]`, `pickup all`, `pickup last`, `--resume`, `--checkout <branch>`                      | Compatible with caveats                           | Good sign that remote session state can be recovered locally, but public guarantees around ownership and replay semantics are still weak.              |
| Interactive terminal access | `niteshift terminal new` and `terminal attach [taskId]`; changelog describes persistent tmux sessions            | Compatible with caveats                           | Useful operator affordance, but this is interactive session attachment, not the same as a machine-oriented cancellation or recovery contract.          |
| Status / observability      | homepage and changelog mention PR links, task status, CI, logs; `watch --json` exists                            | Compatible with caveats                           | Likely enough for a hosted-task status surface if the JSON stream is durable and documented. Not yet proven.                                           |
| Remote workspace model      | homepage says the full dev environment runs in the cloud                                                         | Compatible with caveats                           | Fits `remote-task` better than SSH workspace preparation. Symphony would need to treat the hosted workspace as backend-owned rather than SSH-prepared. |
| Shutdown / cancellation     | no documented `cancel`, `stop`, or non-interactive task termination command in the published README or changelog | Blocked by unknowns                               | This is the main blocker. Symphony needs a real shutdown path, not just abandonment.                                                                   |
| Restart / recovery          | `list`, `pickup`, `sync`, and task URLs suggest reattachment is possible                                         | Blocked by unknowns                               | Promising surface, but not enough evidence that a headless orchestrator can deterministically recover after restart.                                   |
| PR / CI ownership           | changelog advertises merge-ready workflows, CI fixing, and review-comment handling                               | Mismatched with current policy unless constrained | Symphony can only use Niteshift safely if Symphony remains the tracker and PR lifecycle source of truth.                                               |

## Where Niteshift Fits Cleanly

These areas fit the current transport-aware contract without requiring redesign:

- `RunnerTransportKind` already includes `remote-task`
- `taskId` is a plausible `remoteTaskId`
- `watch --json` is a plausible source for hosted-task visibility events
- `prompt <taskId>` is a plausible continuation surface
- task URLs, branch references, and PR links would map naturally into
  observability artifacts if the backend exposes them consistently

In other words, Symphony does not need a new transport kind to describe
Niteshift. The existing `remote-task` seam is the right conceptual bucket.

## Mismatches And Unknowns

### 1. Cancellation is the main blocker

Symphony's remote execution model assumes shutdown is transport-aware. For SSH
stdio, that means there is an explicit termination path. For a hosted backend,
Symphony needs an equivalent non-interactive control-plane action.

Public evidence found:

- no documented `niteshift cancel`
- no documented `niteshift stop <taskId>`
- no public statement that `terminal attach` or `pickup` can be used as a safe
  machine-driven termination boundary

Without this, Symphony can only abandon a task, which is weaker than the
current contract.

### 2. Recovery looks possible but not guaranteed

The existence of `pickup`, `list`, and `sync` suggests that Niteshift preserves
enough remote state to reconnect later. That is encouraging, but Symphony needs
stronger guarantees than "a human can probably resume this task."

What the orchestrator would need:

- a durable task identifier
- a deterministic way to look up the task after restart
- a clear way to tell whether the task is still running, waiting, completed, or
  failed
- a way to distinguish "reattach to the existing task" from "start a new local
  pickup boundary that changes ownership semantics"

Those guarantees are not explicit in the public contract.

### 3. Structured watch output is useful but still underspecified

`watch --json` is the strongest public signal that Niteshift may fit Symphony's
observability needs. But the public docs do not define:

- the schema
- stability guarantees
- completion markers
- whether the same stream is suitable for automation or only for humans

That does not block future work permanently, but it does block assuming the
stream is stable enough for a production runner today.

### 4. Hosted PR automation could conflict with Symphony ownership

Niteshift's product surface emphasizes:

- opening PRs
- fixing CI
- addressing review comments
- merge-ready workflows

That overlaps with Symphony's own orchestrator responsibilities. A safe
integration would need to keep Niteshift limited to execution while Symphony
continues to own:

- issue lifecycle
- retry policy
- recovery decisions
- PR review-loop policy
- landing policy

If Niteshift cannot be constrained that way, it is a policy mismatch even if
the task transport is technically compatible.

## Hosted-Task Facts Symphony Would Need

A future Niteshift-backed runner would need durable access to at least:

- hosted task id
- hosted task URL
- provider and model identity
- current branch and base branch
- PR URL if one exists
- current state: running, waiting, completed, failed, cancelled, or unknown
- a machine-consumable watch or log pointer
- a recovery lookup key if it differs from task id
- an explicit statement of whether cancellation is supported

The current public surface strongly suggests some of these facts exist, but it
does not document the full set at the level Symphony needs.

## Recommended First Follow-Up Slice

Do not start with a full mainline runner implementation.

The smallest credible next issue should be a narrow validation spike that
answers the control-plane unknowns against a disposable repository and task:

1. prove that one created task yields a durable task id and task URL that can
   be persisted as `remoteTaskId`
2. prove that `watch --json` emits enough machine-readable lifecycle state to
   distinguish running, waiting, and terminal outcomes
3. prove that restart recovery can reconnect to the same task deterministically
   using only persisted task identity
4. prove that a non-interactive cancellation or shutdown path exists
5. prove that Symphony can keep PR and tracker ownership without Niteshift
   taking over the control loop

If any of those fail, Symphony should stop and keep Niteshift out of the
runtime.

If all of them pass, the first implementation slice should still stay narrow:

- one opt-in experimental runner
- `transport=remote-task`
- task creation plus watch projection
- follow-up prompting against the same hosted task
- no tracker changes
- no SSH contract changes
- no provider-neutral hosted-backend abstraction work beyond what the existing
  `remote-task` seam already provides

## Final Recommendation

Niteshift is a plausible future `remote-task` backend for Symphony, but it is
not yet proven enough for direct integration.

The public evidence is good enough to justify one more narrow validation issue.
It is not good enough to justify shipping a production runner or relaxing the
current shutdown and recovery expectations.
