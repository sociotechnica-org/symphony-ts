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
    backoff_ms: 5000
workspace:
  root: ./.tmp/workspaces
  repo_url: git@github.com:sociotechnica-org/symphony-ts.git
  branch_prefix: symphony/
  cleanup_on_success: true
hooks:
  after_create: []
agent:
  command: codex exec --dangerously-bypass-approvals-and-sandbox -C . -
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
  {% endif %}

Rules:

1. Work only inside this repository clone.
2. Create or reuse the issue branch for this work.
3. Implement the issue completely.
4. Run the relevant checks before finishing.
5. Open a pull request against `main` in `{{ config.tracker.repo }}`.
6. Reference the issue in the PR body.
7. If the PR already exists, continue on the same branch and address CI or review feedback instead of opening a new PR.
8. Do not treat "PR opened" as complete; keep going until the PR is green and actionable review feedback is resolved.
9. Leave the workspace in a git state that can be inspected if the run fails.
