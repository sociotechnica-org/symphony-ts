#!/usr/bin/env bash
set -euo pipefail

PROMPT="$(cat)"
printf '%s' "$PROMPT" > .agent-prompt.txt

git config user.name "Symphony Test Agent"
git config user.email "symphony-agent@example.com"

echo "implemented ${SYMPHONY_ISSUE_IDENTIFIER} attempt ${SYMPHONY_RUN_ATTEMPT}" > IMPLEMENTED.txt
git add .agent-prompt.txt IMPLEMENTED.txt
git commit -m "Implement ${SYMPHONY_ISSUE_IDENTIFIER} attempt ${SYMPHONY_RUN_ATTEMPT}"
git push origin "HEAD:${SYMPHONY_BRANCH_NAME}"
curl -sS -X POST "${MOCK_GITHUB_API_URL}/mock/branch-pushes" \
  -H 'content-type: application/json' \
  -d "{\"head\":\"${SYMPHONY_BRANCH_NAME}\"}" >/dev/null

if [[ "${SYMPHONY_RUN_ATTEMPT}" -eq 1 ]]; then
  gh pr create \
    --title "Implement ${SYMPHONY_ISSUE_IDENTIFIER}" \
    --body "Automated PR for ${SYMPHONY_ISSUE_IDENTIFIER}" \
    --base main \
    --head "${SYMPHONY_BRANCH_NAME}"
fi
