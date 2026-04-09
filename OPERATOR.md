# Operator Playbook

This file is the repo-owned operator policy for self-hosting `symphony-ts`.
Use it with `WORKFLOW.md`, `AGENTS.md`, `README.md`,
`docs/guides/operator-runbook.md`, and `skills/symphony-operator/SKILL.md`.

## Normal Operator Duties

- Treat technical-plan review, completed-run report review, and posting `/land`
  on ready PRs as normal operator work, not as exceptional intervention.
- Let the factory own dispatch, retries, PR follow-up, and ordinary queue
  movement while it is healthy.
- Fix factory/runtime problems through the normal branch and PR flow instead of
  leaving local-only tracked changes behind.

## Landing Policy

- Post `/land` when the current PR head has green required CI, actionable
  review feedback has been addressed, required approved bot review has been
  observed on the current head, and no release gate is blocking the work.
- If a user explicitly reserves landing for themselves, leave the PR in a
  review-clean ready state instead of posting `/land`.

## Release And Queue Policy

- Treat `.ralph/instances/<instance-key>/release-state.json` as the canonical
  operator-local release artifact.
- Do not promote downstream `symphony:ready` issues or land dependent PRs when
  `release-state.json` reports `blocked-by-prerequisite-failure`,
  `blocked-review-needed`, or a ready-promotion sync failure.
- When release metadata or promotion sync is wrong, fix the underlying problem
  or record a tracked follow-up instead of hand-waving the block away.

## Post-Merge Refresh Policy

- After a merge, fast-forward the selected instance root checkout to the latest
  `origin/main`, rerun `bin/check-factory-runtime-freshness.ts`, and restart
  the detached factory only when that assessment says the runtime engine or
  selected `WORKFLOW.md` is stale.
- Because `symphony-ts` self-hosts, merges that change runtime code or the
  self-hosting `WORKFLOW.md` usually produce drift and therefore usually
  require a restart before the next issue should dispatch.
- If a merge changed unrelated files only and the freshness assessment is
  clear, keep the detached runtime up.

## Intervention And Escalation Policy

- Normal intervention includes plan review, `/land`, report-review follow-up,
  and restarting a stale or degraded detached runtime through the supported
  factory-control commands.
- Do not take over a healthy PR branch manually just because the next fix is
  obvious. Manual branch intervention is for stalled or broken factory
  behavior, not the normal path.
- Pause the line and escalate when continuing automation would make recovery
  harder, such as degraded review infrastructure, a blocked release
  prerequisite, or a failure pattern that the current runtime is not handling
  safely.
