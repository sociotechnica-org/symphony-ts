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

if [[ "${SYMPHONY_RUN_ATTEMPT}" -lt 2 ]]; then
  exit 0
fi

gh pr create \
  --title "Implement ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --body "Automated PR for ${SYMPHONY_ISSUE_IDENTIFIER}" \
  --base main \
  --head "${SYMPHONY_BRANCH_NAME}"
