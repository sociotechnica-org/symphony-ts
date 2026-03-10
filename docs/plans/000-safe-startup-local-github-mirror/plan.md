# Safe startup with local GitHub mirror

Status: waived

Direct operator request; plan review waiting is explicitly waived for this local hardening task.

## Scope

- add a startup path that keeps a local mirror of the upstream GitHub repository under `github/upstream`
- update that mirror before each `run` start
- make the default workflow clone workspaces from the local mirror instead of cloning directly from GitHub
- remove untrusted GitHub-authored body/review text from the default prompt surface

## Non-goals

- redesign the tracker abstraction
- remove GitHub tracking entirely
- change the orchestrator handoff lifecycle

## Boundaries

- configuration: resolve local `workspace.repo_url` paths relative to the workflow file
- integration: add a startup mirror sync module and wrapper CLI entrypoint
- execution: keep the runner/orchestrator contract unchanged
- observability: keep existing logs/status behavior unchanged

## Acceptance

1. starting Symphony through the new safe entrypoint updates `github/upstream` from the configured upstream before `run`
2. the checked-in workflow clones workspaces from the local mirror path, not a live GitHub URL
3. the default prompt no longer injects GitHub issue bodies or review feedback bodies into Codex input
4. targeted tests cover mirror sync behavior and local `workspace.repo_url` resolution
