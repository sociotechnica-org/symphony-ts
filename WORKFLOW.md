---
tracker:
  kind: github-bootstrap
  repo: sociotechnica-org/symphony-ts
  api_url: https://api.github.com
  ready_label: symphony:ready
  running_label: symphony:running
  failed_label: symphony:failed
  success_comment: Symphony completed this issue successfully.
  review_bot_logins:
    - greptile[bot]
    - bugbot[bot]
polling:
  interval_ms: 30000
  max_concurrent_runs: 1
  retry:
    max_attempts: 2
    max_follow_up_attempts: 2
    backoff_ms: 5000
workspace:
  root: ./.tmp/workspaces
  repo_url: git@github.com:sociotechnica-org/symphony-ts.git
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create: []
agent:
  command: codex exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4 -C . -
  prompt_transport: stdin
  timeout_ms: 1800000
  env:
    GITHUB_REPO: sociotechnica-org/symphony-ts
---

You are working on issue {{ issue.identifier }}: {{ issue.title }}.

Issue URL: {{ issue.url }}
Labels: {{ issue.labels | join: ", " }}

Description:
{{ issue.description }}

{% if pull_request %}
Pull Request State:

- Status: {{ pull_request.kind }}
- URL: {{ pull_request.pullRequest.url }}
- Pending checks: {{ pull_request.pendingCheckNames | join: ", " }}
- Failing checks: {{ pull_request.failingCheckNames | join: ", " }}
- Actionable feedback count: {{ pull_request.actionableReviewFeedback | size }}
  {%- if pull_request.actionableReviewFeedback.size > 0 %}
  Actionable feedback:
  {%- for feedback in pull_request.actionableReviewFeedback %}
- [{{ feedback.authorLogin | default: "unknown" }}] {{ feedback.body }} ({{ feedback.url }})
  {%- endfor %}
  {%- endif %}
  {%- endif %}

Rules:

1. Read `AGENTS.md`, `README.md`, and the relevant docs before making changes.
2. Work only inside this repository clone.
3. Create or reuse the issue branch for this work.
4. For implementation issues, read `skills/symphony-plan/SKILL.md` and use it to create or update `docs/plans/<issue-number>-<task-name>/plan.md` before substantial code changes.
5. Comment on the GitHub issue when the plan is ready for review.
6. If explicitly instructed not to wait for human feedback, continue directly from plan into implementation.
7. Implement the issue completely, including docs and tests required by the repo process.
8. Run `codex review --base origin/main` on your changes and fix the findings before opening a PR.
9. Run the relevant local checks before finishing.
10. Open a pull request against `main` in `{{ config.tracker.repo }}` and reference the issue in the PR body.
11. If the PR already exists, continue on the same branch and address CI or review feedback instead of opening a new PR.
12. Monitor CI and automated review feedback, address follow-up comments, and do not treat the CI/review stage as complete until all checks pass and all actionable comments are resolved. If a CI or automated review check remains in a non-terminal state for more than 30 minutes without progress, comment on the issue describing the blocked check and wait for human guidance before proceeding.
13. Leave the workspace in a git state that can be inspected if the run fails.
