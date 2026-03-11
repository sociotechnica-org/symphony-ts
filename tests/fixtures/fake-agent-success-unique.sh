#!/usr/bin/env bash
set -euo pipefail

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Test Agent"
git config user.email "symphony-agent@example.com"

STAMP="$(date +%s%N)"
echo "implemented ${SYMPHONY_ISSUE_IDENTIFIER} ${STAMP}" > IMPLEMENTED.txt
git add .agent-prompt.txt IMPLEMENTED.txt
git commit -m "Implement ${SYMPHONY_ISSUE_IDENTIFIER} ${STAMP}"
git push origin HEAD:${SYMPHONY_BRANCH_NAME}
curl -sS -X POST "${MOCK_GITHUB_API_URL}/mock/branch-pushes" \
  -H 'content-type: application/json' \
  -d "{\"head\":\"${SYMPHONY_BRANCH_NAME}\"}" >/dev/null

gh pr create \
  --title "Implement ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --body "Automated PR for ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --base main \
  --head "${SYMPHONY_BRANCH_NAME}"
